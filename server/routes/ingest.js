/**
 * Message ingestion routes.
 *
 * POST /ingest — ingest conversation messages for a peer
 * POST /derive — manually trigger derivation of explicit observations
 */

import { Router } from 'express';
import crypto from 'node:crypto';

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

export function createIngestRouter(pool, agents, vectr, deriveTokenThreshold) {
  const router = Router();

  // POST /ingest — ingest messages
  router.post('/ingest', async (req, res) => {
    try {
      const { peer_id, session_id, messages } = req.body;

      if (!peer_id || !messages || !Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: 'peer_id and messages[] are required' });
      }

      // Verify peer exists
      const peer = await pool.query("SELECT id FROM peers WHERE id = $1 AND status = 'active'", [peer_id]);
      if (peer.rows.length === 0) {
        return res.status(404).json({ error: 'PEER_NOT_FOUND', peer_id });
      }

      // Create or reuse session
      const sessId = session_id || `urn:minder:session:${Date.now()}`;
      await pool.query(
        'INSERT INTO sessions (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
        [sessId],
      );
      await pool.query(
        'INSERT INTO session_peers (session_id, peer_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [sessId, peer_id],
      );

      // Insert messages
      let totalTokens = 0;
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const tokenCount = Math.ceil((msg.content?.length || 0) / 4);
        totalTokens += tokenCount;

        await pool.query(`
          INSERT INTO messages (session_id, peer_id, content, metadata, token_count, seq)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [sessId, peer_id, msg.content, JSON.stringify(msg.metadata || {}), tokenCount, i + 1]);
      }

      // Check if derive threshold exceeded
      const pendingTokens = await pool.query(`
        SELECT COALESCE(SUM(token_count), 0) AS total
        FROM messages
        WHERE session_id = $1
          AND (metadata->>'derived')::boolean IS NOT TRUE
      `, [sessId]);

      const pending = parseInt(pendingTokens.rows[0].total);
      let deriveQueued = false;

      if (pending >= deriveTokenThreshold && agents.isAvailable()) {
        await pool.query(`
          INSERT INTO queue (task_type, work_unit_key, payload, status)
          VALUES ('derive', $1, $2, 'pending')
        `, [sessId, JSON.stringify({ session_id: sessId, peer_id })]);
        deriveQueued = true;
      }

      res.json({
        session_id: sessId,
        messages_ingested: messages.length,
        total_tokens: totalTokens,
        derive_queued: deriveQueued,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /derive — manually trigger derivation
  router.post('/derive', async (req, res) => {
    try {
      if (!agents.isAvailable()) {
        return res.status(503).json({ error: 'LLM unavailable' });
      }

      // Get pending derive tasks
      const pending = await pool.query(`
        SELECT id, work_unit_key, payload FROM queue
        WHERE task_type = 'derive' AND status = 'pending'
        ORDER BY created_at
        LIMIT 10
      `);

      const results = [];

      for (const task of pending.rows) {
        const payload = task.payload;
        const sessionId = payload.session_id;
        const peerId = payload.peer_id;

        // Get underivedmessages
        const msgs = await pool.query(`
          SELECT id, content FROM messages
          WHERE session_id = $1 AND (metadata->>'derived')::boolean IS NOT TRUE
          ORDER BY seq
        `, [sessionId]);

        if (msgs.rows.length === 0) {
          await pool.query("UPDATE queue SET status = 'completed', completed_at = NOW() WHERE id = $1", [task.id]);
          continue;
        }

        const text = msgs.rows.map(m => m.content).join('\n');

        // Call deriver agent
        try {
          const response = await agents.deriver.chat(
            [{ role: 'user', content: text }],
            {
              system: `Extract atomic explicit observations from this conversation text about the person with peer_id ${peerId}. Each observation should be a single factual statement. Return JSON: { "observations": [{ "content": "...", "confidence": "high|medium|low", "dedup_key": "3-5 word slug" }] }`,
            },
          );

          let observations = [];
          try {
            const parsed = JSON.parse(response.content);
            observations = parsed.observations || [];
          } catch {
            log('derive_parse_error', { session_id: sessionId });
          }

          // Store observations
          // Ensure collection exists
          const collectionId = `urn:minder:collection:agent-${peerId.split(':').pop()}`;
          await pool.query(
            'INSERT INTO collections (id, observer_id, observed_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
            [collectionId, 'urn:minder:peer:agent', peerId],
          );

          for (const obs of observations) {
            const hash = crypto.createHash('sha256').update(obs.content).digest('hex').slice(0, 12);
            const obsId = `urn:minder:observation:${hash}`;
            const embedding = await vectr.embed(obs.content);

            try {
              await pool.query(`
                INSERT INTO observations (id, collection_id, content, level, confidence, embedding, dedup_key)
                VALUES ($1, $2, $3, 'explicit', $4, $5, $6)
                ON CONFLICT (collection_id, level, dedup_key) WHERE deleted_at IS NULL AND dedup_key IS NOT NULL
                DO UPDATE SET times_derived = observations.times_derived + 1
              `, [obsId, collectionId, obs.content, obs.confidence || 'medium', embedding ? JSON.stringify(embedding) : null, obs.dedup_key || null]);
            } catch (err) {
              // Duplicate ID — increment times_derived
              await pool.query('UPDATE observations SET times_derived = times_derived + 1 WHERE id = $1', [obsId]).catch(() => {});
            }
          }

          // Mark messages as derived
          for (const msg of msgs.rows) {
            await pool.query("UPDATE messages SET metadata = metadata || '{\"derived\": true}' WHERE id = $1", [msg.id]);
          }

          results.push({ session_id: sessionId, observations_created: observations.length });
        } catch (err) {
          log('derive_error', { session_id: sessionId, error: err.message });
          results.push({ session_id: sessionId, error: err.message });
        }

        await pool.query("UPDATE queue SET status = 'completed', completed_at = NOW() WHERE id = $1", [task.id]);
      }

      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
