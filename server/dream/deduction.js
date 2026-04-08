/**
 * Dream Phase 1 — Deduction.
 *
 * For each peer's collections, load explicit observations and
 * derive logical conclusions using the deduction worker (Haiku).
 * Two-layer dedup: dedup_key match, then text match.
 */

import crypto from 'node:crypto';

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

export async function runDeduction(pool, deductionWorker, vectr, peerId) {
  log('dream_deduction_start', { peer_id: peerId });

  const result = { created: 0, duplicates: 0, errors: 0 };

  // Get collections for this peer
  const collections = await pool.query(
    'SELECT id FROM collections WHERE observed_id = $1', [peerId],
  );

  for (const col of collections.rows) {
    // Load explicit observations
    const explicits = await pool.query(`
      SELECT content, confidence FROM observations
      WHERE collection_id = $1 AND level = 'explicit' AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 50
    `, [col.id]);

    if (explicits.rows.length === 0) continue;

    // Load existing deductions for dedup
    const existingDeductions = await pool.query(`
      SELECT dedup_key, content FROM observations
      WHERE collection_id = $1 AND level = 'deductive' AND deleted_at IS NULL
    `, [col.id]);

    const existingKeys = new Set(existingDeductions.rows.map(r => r.dedup_key).filter(Boolean));
    const existingContents = new Set(existingDeductions.rows.map(r => r.content));

    const facts = explicits.rows.map(e => `[${e.confidence}] ${e.content}`).join('\n');

    try {
      const response = await deductionWorker.chat(
        [{ role: 'user', content: facts }],
        {
          system: `Given these explicit observations, derive logical conclusions — things that MUST be true based on the facts. Return JSON: { "deductions": [{ "content": "...", "confidence": "high|medium|low", "dedup_key": "3-5 word slug" }] }. Only include genuinely new logical inferences, not restatements.`,
        },
      );

      let deductions = [];
      try {
        const parsed = JSON.parse(response.content);
        deductions = parsed.deductions || [];
      } catch { continue; }

      for (const ded of deductions) {
        // Dedup check
        if (ded.dedup_key && existingKeys.has(ded.dedup_key)) {
          result.duplicates++;
          await pool.query(`
            UPDATE observations SET times_derived = times_derived + 1
            WHERE collection_id = $1 AND level = 'deductive' AND dedup_key = $2 AND deleted_at IS NULL
          `, [col.id, ded.dedup_key]).catch(() => {});
          continue;
        }

        if (existingContents.has(ded.content)) {
          result.duplicates++;
          continue;
        }

        const hash = crypto.createHash('sha256').update(ded.content).digest('hex').slice(0, 12);
        const obsId = `urn:minder:observation:${hash}`;
        const embedding = await vectr.embed(ded.content);

        try {
          await pool.query(`
            INSERT INTO observations (id, collection_id, content, level, confidence, embedding, dedup_key)
            VALUES ($1, $2, $3, 'deductive', $4, $5, $6)
          `, [obsId, col.id, ded.content, ded.confidence || 'medium', embedding ? JSON.stringify(embedding) : null, ded.dedup_key || null]);
          result.created++;
        } catch {
          result.duplicates++;
        }
      }
    } catch (err) {
      log('dream_deduction_error', { collection_id: col.id, error: err.message });
      result.errors++;
    }
  }

  log('dream_deduction_complete', { peer_id: peerId, ...result });
  return result;
}
