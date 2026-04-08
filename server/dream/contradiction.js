/**
 * Dream Phase 3 — Contradiction Detection.
 *
 * Find mutually exclusive observations. The lower-priority one is
 * soft-deleted (explicit > deductive > inductive; tiebreak: confidence).
 */

import crypto from 'node:crypto';

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

const LEVEL_PRIORITY = { explicit: 3, deductive: 2, inductive: 1, contradiction: 0 };
const CONFIDENCE_PRIORITY = { high: 3, medium: 2, low: 1 };

export async function runContradiction(pool, dialecticWorker, peerId) {
  log('dream_contradiction_start', { peer_id: peerId });

  const result = { found: 0, soft_deleted: 0, errors: 0 };

  const collections = await pool.query(
    'SELECT id FROM collections WHERE observed_id = $1', [peerId],
  );

  for (const col of collections.rows) {
    // Load non-deleted, non-contradiction observations
    const obs = await pool.query(`
      SELECT id, content, level, confidence FROM observations
      WHERE collection_id = $1 AND level != 'contradiction' AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 80
    `, [col.id]);

    if (obs.rows.length < 2) continue;

    const obsText = obs.rows.map((o, i) => `[${i}] [${o.level}|${o.confidence}] ${o.content}`).join('\n');

    try {
      const response = await dialecticWorker.chat(
        [{ role: 'user', content: obsText }],
        {
          system: 'Identify pairs of observations that are genuinely mutually exclusive — they cannot both be true. NOT agreement, NOT rephrasing, NOT expansion. Only real logical contradictions. Return JSON: { "contradictions": [{ "index_a": 0, "index_b": 1, "explanation": "why they contradict" }] }. Return empty array if none found.',
          thinking: true,
          thinkingBudget: 5000,
        },
      );

      let contradictions = [];
      try {
        const parsed = JSON.parse(response.content);
        contradictions = parsed.contradictions || [];
      } catch { continue; }

      for (const c of contradictions) {
        if (c.index_a >= obs.rows.length || c.index_b >= obs.rows.length) continue;

        const obsA = obs.rows[c.index_a];
        const obsB = obs.rows[c.index_b];

        // Check if this pair was already flagged (dedup by sorted pair IDs)
        const pairKey = [obsA.id, obsB.id].sort().join('|');
        const existing = await pool.query(`
          SELECT id FROM observations
          WHERE collection_id = $1 AND level = 'contradiction' AND deleted_at IS NULL
            AND metadata->>'pair_key' = $2
        `, [col.id, pairKey]);

        if (existing.rows.length > 0) continue;

        // Determine which to soft-delete (lower priority)
        const priorityA = (LEVEL_PRIORITY[obsA.level] || 0) * 10 + (CONFIDENCE_PRIORITY[obsA.confidence] || 0);
        const priorityB = (LEVEL_PRIORITY[obsB.level] || 0) * 10 + (CONFIDENCE_PRIORITY[obsB.confidence] || 0);
        const loser = priorityA <= priorityB ? obsA : obsB;

        // Create contradiction observation
        const hash = crypto.createHash('sha256').update(pairKey).digest('hex').slice(0, 12);
        const contraId = `urn:minder:observation:${hash}`;

        try {
          await pool.query(`
            INSERT INTO observations (id, collection_id, content, level, confidence, source_ids, metadata)
            VALUES ($1, $2, $3, 'contradiction', 'high', $4, $5)
          `, [
            contraId,
            col.id,
            c.explanation,
            JSON.stringify([obsA.id, obsB.id]),
            JSON.stringify({ pair_key: pairKey, soft_deleted: loser.id }),
          ]);

          // Soft-delete the lower-priority observation
          await pool.query('UPDATE observations SET deleted_at = NOW() WHERE id = $1', [loser.id]);

          result.found++;
          result.soft_deleted++;
        } catch {
          result.errors++;
        }
      }
    } catch (err) {
      log('dream_contradiction_error', { collection_id: col.id, error: err.message });
      result.errors++;
    }
  }

  log('dream_contradiction_complete', { peer_id: peerId, ...result });
  return result;
}
