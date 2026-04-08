/**
 * Dream Phase 2 — Induction.
 *
 * Identify patterns, traits, preferences, motivations, predictions
 * from all observation levels using the induction worker (Sonnet).
 */

import crypto from 'node:crypto';

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

export async function runInduction(pool, inductionWorker, vectr, peerId) {
  log('dream_induction_start', { peer_id: peerId });

  const result = { created: 0, duplicates: 0, updated: 0, errors: 0 };

  const collections = await pool.query(
    'SELECT id FROM collections WHERE observed_id = $1', [peerId],
  );

  for (const col of collections.rows) {
    // Load all non-deleted observations
    const allObs = await pool.query(`
      SELECT content, level, confidence FROM observations
      WHERE collection_id = $1 AND deleted_at IS NULL
      ORDER BY level, created_at DESC
      LIMIT 100
    `, [col.id]);

    if (allObs.rows.length < 3) continue; // need enough data

    const existingInductives = await pool.query(`
      SELECT id, dedup_key, content, metadata FROM observations
      WHERE collection_id = $1 AND level = 'inductive' AND deleted_at IS NULL
    `, [col.id]);

    const existingKeys = new Set(existingInductives.rows.map(r => r.dedup_key).filter(Boolean));

    const obsText = allObs.rows.map(o => `[${o.level}|${o.confidence}] ${o.content}`).join('\n');

    try {
      const response = await inductionWorker.chat(
        [{ role: 'user', content: obsText }],
        {
          system: `Analyze these observations and identify patterns, traits, preferences, motivations, and predictions about this person. Return JSON: { "inductions": [{ "content": "...", "confidence": "high|medium|low", "category": "PREFERENCE|TRAIT|PATTERN|MOTIVATION|PREDICTION", "dedup_key": "3-5 word slug" }] }. Be selective — only include genuinely insightful inferences.`,
        },
      );

      let inductions = [];
      try {
        const parsed = JSON.parse(response.content);
        inductions = parsed.inductions || [];
      } catch { continue; }

      for (const ind of inductions) {
        if (ind.dedup_key && existingKeys.has(ind.dedup_key)) {
          // Update confidence and category on existing
          await pool.query(`
            UPDATE observations
            SET times_derived = times_derived + 1,
                confidence = $2,
                metadata = jsonb_set(COALESCE(metadata, '{}'), '{category}', $3)
            WHERE collection_id = $1 AND level = 'inductive' AND dedup_key = $4 AND deleted_at IS NULL
          `, [col.id, ind.confidence || 'medium', JSON.stringify(ind.category || 'PATTERN'), ind.dedup_key]).catch(() => {});
          result.updated++;
          continue;
        }

        const hash = crypto.createHash('sha256').update(ind.content).digest('hex').slice(0, 12);
        const obsId = `urn:minder:observation:${hash}`;
        const embedding = await vectr.embed(ind.content);
        const metadata = { category: ind.category || 'PATTERN' };

        try {
          await pool.query(`
            INSERT INTO observations (id, collection_id, content, level, confidence, embedding, dedup_key, metadata)
            VALUES ($1, $2, $3, 'inductive', $4, $5, $6, $7)
          `, [obsId, col.id, ind.content, ind.confidence || 'medium', embedding ? JSON.stringify(embedding) : null, ind.dedup_key || null, JSON.stringify(metadata)]);
          result.created++;
        } catch {
          result.duplicates++;
        }
      }
    } catch (err) {
      log('dream_induction_error', { collection_id: col.id, error: err.message });
      result.errors++;
    }
  }

  log('dream_induction_complete', { peer_id: peerId, ...result });
  return result;
}
