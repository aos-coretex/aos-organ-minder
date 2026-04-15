/**
 * Minder organ tool methods — MP-TOOL-1 relay t8r-4.
 *
 * 14 thin wrappers over Minder internals (pool + vectr + agents + triggerDream).
 *
 * Binding decision #20: LLM-dependent methods detect absence of the API key at
 * method entry via `agents.isAvailable()` and throw `llm_unavailable` which the
 * handler surfaces as TOOL_ERROR. Never synthesize placeholder LLM responses.
 *
 * D7: no Spine OTM emissions. `identify`, `register_peer`, `retire_peer` are
 * tempting places to emit observability events — resist; live-loop handles any
 * cross-organ notifications at the dispatch layer, not inside tool methods.
 *
 * The method bodies mirror Minder's HTTP route implementations —
 * duplication is intentional and matches the pattern established in R3.
 */

import crypto from 'node:crypto';

function bad(code, message, extra) {
  const err = new Error(message);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * @param {object} deps
 * @param {object} deps.pool           — pg Pool
 * @param {object} deps.vectr          — Vectr client
 * @param {object} deps.agents         — LLM agents (createAgents result); exposes `.isAvailable()` + per-agent `.chat()`
 * @param {function} [deps.triggerDream] — (peerId, force) => dream result; bound in index.js
 * @param {number} [deps.deriveTokenThreshold=1000]
 */
export function createToolMethods({ pool, vectr, agents, triggerDream, deriveTokenThreshold = 1000 }) {
  // Helper used by every LLM-dependent method per #20.
  function ensureLLM() {
    if (!agents.isAvailable()) {
      throw bad('llm_unavailable', 'Minder LLM agents unavailable (ANTHROPIC_API_KEY not set or provider degraded)');
    }
  }

  return {
    // -----------------------------------------------------------------
    // Identity + peers (non-LLM)
    // -----------------------------------------------------------------

    /**
     * minder__identify — identify peer by name; creates session.
     * Live evidence: this call was the one that MESSAGE_TIMEOUTed in the
     * session-9 bootstrap — this method closes that failure mode.
     */
    identify: async (params) => {
      const { name, code } = params || {};
      if (!name) {
        throw bad('EBADPARAM', 'name is required');
      }
      const peerId = `urn:minder:peer:${slugify(name)}`;

      const peer = await pool.query(
        'SELECT id, name, peer_type, status, card, metadata, created_at FROM peers WHERE id = $1',
        [peerId]
      );

      if (peer.rows.length === 0) {
        return { status: 'unknown', peer_id: peerId, name };
      }

      const p = peer.rows[0];
      if (p.status === 'retired') {
        return { status: 'retired', peer_id: peerId, name: p.name };
      }

      if (code) {
        const meta = p.metadata || {};
        if (meta.verification_code && meta.verification_code !== code) {
          return { status: 'verification_failed', peer_id: peerId, name: p.name };
        }
      }

      const sessionId = `urn:minder:session:${Date.now()}`;
      await pool.query('INSERT INTO sessions (id) VALUES ($1) ON CONFLICT DO NOTHING', [sessionId]);
      await pool.query(
        'INSERT INTO session_peers (session_id, peer_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [sessionId, peerId]
      );

      const card = p.card || {};
      const entries = card.entries || [];
      const topEntries = entries.slice(0, 5);

      const lastSession = await pool.query(`
        SELECT s.id AS session_id, s.name AS session_name, sp.joined_at
        FROM session_peers sp
        JOIN sessions s ON s.id = sp.session_id
        WHERE sp.peer_id = $1
        ORDER BY sp.joined_at DESC
        LIMIT 1 OFFSET 1
      `, [peerId]);

      return {
        status: 'identified',
        peer_id: peerId,
        name: p.name,
        peer_type: p.peer_type,
        created_at: p.created_at,
        card_summary: {
          total_entries: entries.length,
          dream_cycle: card.dream_cycle || 0,
          last_updated: card.last_updated || null,
          top_entries: topEntries,
        },
        last_session: lastSession.rows[0] || null,
      };
    },

    /**
     * minder__register_peer — create a new peer.
     */
    registerPeer: async (params) => {
      const { name, peer_type = 'human', entity_urn } = params || {};
      if (!name) throw bad('EBADPARAM', 'name is required');

      const peerId = `urn:minder:peer:${slugify(name)}`;
      const existing = await pool.query('SELECT id, status FROM peers WHERE id = $1', [peerId]);
      if (existing.rows.length > 0) {
        if (existing.rows[0].status === 'retired') {
          throw bad('PEER_RETIRED', `Peer is retired: ${peerId}`);
        }
        throw bad('PEER_EXISTS', `Peer already exists: ${peerId}`);
      }

      await pool.query(
        `INSERT INTO peers (id, name, peer_type, status, entity_urn)
         VALUES ($1, $2, $3, 'active', $4)`,
        [peerId, name, peer_type, entity_urn || null]
      );
      return { peer_id: peerId, name, peer_type, status: 'active' };
    },

    /**
     * minder__retire_peer — soft-retire a peer (UPDATE status).
     */
    retirePeer: async (params) => {
      const { peer_id } = params || {};
      if (!peer_id) throw bad('EBADPARAM', 'peer_id is required');

      const result = await pool.query(
        `UPDATE peers SET status = 'retired', retired_at = NOW()
         WHERE id = $1 AND status = 'active'
         RETURNING id`,
        [peer_id]
      );
      if (result.rows.length === 0) {
        throw bad('PEER_NOT_FOUND', 'Peer not found or already retired');
      }
      return { peer_id, status: 'retired' };
    },

    // -----------------------------------------------------------------
    // Ingest + derive (non-LLM + LLM)
    // -----------------------------------------------------------------

    /**
     * minder__ingest — batch-insert messages for a peer session.
     */
    ingest: async (params) => {
      const { peer_id, session_id, messages } = params || {};
      if (!peer_id || !Array.isArray(messages) || messages.length === 0) {
        throw bad('EBADPARAM', 'peer_id and non-empty messages[] are required');
      }

      const peer = await pool.query(
        `SELECT id FROM peers WHERE id = $1 AND status = 'active'`,
        [peer_id]
      );
      if (peer.rows.length === 0) {
        throw bad('PEER_NOT_FOUND', `Peer not found or not active: ${peer_id}`);
      }

      const sessId = session_id || `urn:minder:session:${Date.now()}`;
      await pool.query(
        'INSERT INTO sessions (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
        [sessId]
      );
      await pool.query(
        'INSERT INTO session_peers (session_id, peer_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [sessId, peer_id]
      );

      let totalTokens = 0;
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const tokenCount = Math.ceil((msg.content?.length || 0) / 4);
        totalTokens += tokenCount;
        await pool.query(
          `INSERT INTO messages (session_id, peer_id, content, metadata, token_count, seq)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [sessId, peer_id, msg.content, JSON.stringify(msg.metadata || {}), tokenCount, i + 1]
        );
      }

      // Queue derive if over threshold AND LLM available (no failure if not — queueing is best-effort).
      let deriveQueued = false;
      const pendingTokens = await pool.query(
        `SELECT COALESCE(SUM(token_count), 0) AS total
         FROM messages
         WHERE session_id = $1
           AND (metadata->>'derived')::boolean IS NOT TRUE`,
        [sessId]
      );
      const pending = parseInt(pendingTokens.rows[0].total);
      if (pending >= deriveTokenThreshold && agents.isAvailable()) {
        await pool.query(
          `INSERT INTO queue (task_type, work_unit_key, payload, status)
           VALUES ('derive', $1, $2, 'pending')`,
          [sessId, JSON.stringify({ session_id: sessId, peer_id })]
        );
        deriveQueued = true;
      }

      return {
        session_id: sessId,
        messages_ingested: messages.length,
        total_tokens: totalTokens,
        derive_queued: deriveQueued,
      };
    },

    /**
     * minder__derive — LLM-dependent. Process up to 10 pending derive tasks.
     * Returns per-task summary. On LLM absence, fails with `llm_unavailable`.
     */
    derive: async () => {
      ensureLLM();

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

        const msgs = await pool.query(`
          SELECT id, content FROM messages
          WHERE session_id = $1 AND (metadata->>'derived')::boolean IS NOT TRUE
          ORDER BY seq
        `, [sessionId]);

        if (msgs.rows.length === 0) {
          await pool.query(
            `UPDATE queue SET status = 'completed', completed_at = NOW() WHERE id = $1`,
            [task.id]
          );
          continue;
        }

        const text = msgs.rows.map(m => m.content).join('\n');
        let observations = [];
        try {
          const response = await agents.deriver.chat(
            [{ role: 'user', content: text }],
            {
              system: `Extract atomic explicit observations from this conversation text about the person with peer_id ${peerId}. Each observation should be a single factual statement. Return JSON: { "observations": [{ "content": "...", "confidence": "high|medium|low", "dedup_key": "3-5 word slug" }] }`,
            }
          );
          try {
            const parsed = JSON.parse(response.content);
            observations = parsed.observations || [];
          } catch {
            // Parse failure — treat as empty, task is still marked completed
          }

          const collectionId = `urn:minder:collection:agent-${peerId.split(':').pop()}`;
          await pool.query(
            `INSERT INTO collections (id, observer_id, observed_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [collectionId, 'urn:minder:peer:agent', peerId]
          );

          for (const obs of observations) {
            const hash = crypto.createHash('sha256').update(obs.content).digest('hex').slice(0, 12);
            const obsId = `urn:minder:observation:${hash}`;
            const embedding = await vectr.embed(obs.content);
            await pool.query(
              `INSERT INTO observations (id, collection_id, content, level, confidence, embedding, dedup_key)
               VALUES ($1, $2, $3, 'explicit', $4, $5, $6)
               ON CONFLICT (collection_id, level, dedup_key) WHERE deleted_at IS NULL AND dedup_key IS NOT NULL
               DO UPDATE SET times_derived = observations.times_derived + 1`,
              [obsId, collectionId, obs.content, obs.confidence || 'medium', embedding ? JSON.stringify(embedding) : null, obs.dedup_key || null]
            ).catch(async () => {
              await pool.query(
                `UPDATE observations SET times_derived = times_derived + 1 WHERE id = $1`,
                [obsId]
              ).catch(() => {});
            });
          }

          for (const msg of msgs.rows) {
            await pool.query(
              `UPDATE messages SET metadata = metadata || '{"derived": true}' WHERE id = $1`,
              [msg.id]
            );
          }

          results.push({ session_id: sessionId, observations_created: observations.length });
        } catch (err) {
          results.push({ session_id: sessionId, error: err.message });
        }

        await pool.query(
          `UPDATE queue SET status = 'completed', completed_at = NOW() WHERE id = $1`,
          [task.id]
        );
      }

      return { results, processed_count: results.length };
    },

    // -----------------------------------------------------------------
    // Query + search (LLM / vectr)
    // -----------------------------------------------------------------

    /**
     * minder__query — LLM-dependent NL query over a person's card + observations.
     */
    query: async (params) => {
      const { peer_id, question, observer_id, limit = 10 } = params || {};
      if (!peer_id || !question) {
        throw bad('EBADPARAM', 'peer_id and question are required');
      }
      ensureLLM();

      const peer = await pool.query('SELECT name, card FROM peers WHERE id = $1', [peer_id]);
      if (peer.rows.length === 0) {
        throw bad('PEER_NOT_FOUND', `Peer not found: ${peer_id}`);
      }

      const card = peer.rows[0].card || {};
      const cardEntries = card.entries || [];

      let obsSql = `
        SELECT o.id, o.content, o.level, o.confidence
        FROM observations o
        JOIN collections c ON o.collection_id = c.id
        WHERE c.observed_id = $1 AND o.deleted_at IS NULL
      `;
      const sqlParams = [peer_id];
      let idx = 2;
      if (observer_id) {
        obsSql += ` AND c.observer_id = $${idx}`;
        sqlParams.push(observer_id);
        idx++;
      }
      obsSql += ` ORDER BY o.created_at DESC LIMIT $${idx}`;
      sqlParams.push(parseInt(limit));

      const obs = await pool.query(obsSql, sqlParams);

      const cardText = cardEntries.map(e => `[${e.type}] ${e.content}`).join('\n');
      const obsText = obs.rows.map(o => `[${o.level}|${o.confidence}] ${o.content}`).join('\n');
      const context = `Person: ${peer.rows[0].name}\n\nCard:\n${cardText}\n\nObservations:\n${obsText}`;

      const response = await agents.dialecticWorker.chat(
        [{ role: 'user', content: `Question: ${question}\n\n${context}` }],
        {
          system: 'You are a person understanding agent. Answer the question about this person using the provided card and observations. Be concise (max 1024 tokens). Cite observation IDs when relevant.',
          thinking: true,
          thinkingBudget: 5000,
        }
      );

      return {
        answer: response.content,
        sources: obs.rows.map(o => o.id),
        observation_count: obs.rows.length,
        peer: peer.rows[0].name,
      };
    },

    /**
     * minder__search — semantic search (vectr). NOT LLM-dependent.
     * Surfaces EMBEDDING_UNAVAILABLE when vectr returns null.
     */
    search: async (params) => {
      const { query, peer_id, level, limit = 10 } = params || {};
      if (!query) throw bad('EBADPARAM', 'query is required');

      const embedding = await vectr.embed(query);
      if (!embedding) {
        throw bad('EMBEDDING_UNAVAILABLE', 'Vectr is not reachable — cannot embed query');
      }

      let sql = `
        SELECT
          o.id, o.content, o.level, o.confidence, o.times_derived, o.created_at,
          1 - (o.embedding <=> $1::vector) AS similarity
        FROM observations o
        JOIN collections c ON o.collection_id = c.id
        WHERE o.embedding IS NOT NULL
          AND o.deleted_at IS NULL
          AND (o.embedding <=> $1::vector) < 0.3
      `;
      const sqlParams = [JSON.stringify(embedding)];
      let idx = 2;

      if (peer_id) { sql += ` AND c.observed_id = $${idx}`; sqlParams.push(peer_id); idx++; }
      if (level) { sql += ` AND o.level = $${idx}`; sqlParams.push(level); idx++; }
      sql += ` ORDER BY similarity DESC LIMIT $${idx}`;
      sqlParams.push(parseInt(limit));

      const result = await pool.query(sql, sqlParams);
      return {
        count: result.rows.length,
        results: result.rows.map(r => ({
          id: r.id,
          content: r.content,
          level: r.level,
          confidence: r.confidence,
          times_derived: r.times_derived,
          similarity: parseFloat(r.similarity),
          created_at: r.created_at,
        })),
      };
    },

    // -----------------------------------------------------------------
    // Understanding (non-LLM reads)
    // -----------------------------------------------------------------

    /**
     * minder__get_card — non-LLM read of peer card entries.
     */
    getCard: async (params) => {
      const { peer_id } = params || {};
      if (!peer_id) throw bad('EBADPARAM', 'peer_id is required');

      const result = await pool.query(
        `SELECT id, name, peer_type, status, card, created_at FROM peers WHERE id = $1`,
        [peer_id]
      );
      if (result.rows.length === 0) {
        throw bad('PEER_NOT_FOUND', `Peer not found: ${peer_id}`);
      }
      const peer = result.rows[0];
      const card = peer.card || {};
      const entries = card.entries || [];

      return {
        peer_id: peer.id,
        name: peer.name,
        peer_type: peer.peer_type,
        status: peer.status,
        card: entries,
        card_entries: entries.length,
        created_at: peer.created_at,
      };
    },

    /**
     * minder__get_representation — card + observation stats.
     */
    getRepresentation: async (params) => {
      const { peer_id } = params || {};
      if (!peer_id) throw bad('EBADPARAM', 'peer_id is required');

      const peer = await pool.query('SELECT * FROM peers WHERE id = $1', [peer_id]);
      if (peer.rows.length === 0) {
        throw bad('PEER_NOT_FOUND', `Peer not found: ${peer_id}`);
      }
      const p = peer.rows[0];
      const card = p.card || {};

      const obsStats = await pool.query(
        `SELECT level, COUNT(*) AS count
         FROM observations o
         JOIN collections c ON o.collection_id = c.id
         WHERE c.observed_id = $1 AND o.deleted_at IS NULL
         GROUP BY level`,
        [peer_id]
      );
      const byLevel = {};
      let total = 0;
      for (const row of obsStats.rows) {
        byLevel[row.level] = parseInt(row.count);
        total += parseInt(row.count);
      }

      const observers = await pool.query(
        `SELECT COUNT(DISTINCT c.observer_id) AS count
         FROM collections c
         JOIN observations o ON o.collection_id = c.id
         WHERE c.observed_id = $1 AND o.deleted_at IS NULL`,
        [peer_id]
      );

      return {
        peer_id: p.id,
        name: p.name,
        card: card.entries || [],
        observations_by_level: byLevel,
        total_observations: total,
        observer_count: parseInt(observers.rows[0].count),
      };
    },

    // -----------------------------------------------------------------
    // Stats + config (non-LLM)
    // -----------------------------------------------------------------

    /**
     * minder__stats — aggregate stats.
     */
    stats: async () => {
      const peerStats = await pool.query(
        `SELECT COUNT(*) FILTER (WHERE status = 'active') AS active, COUNT(*) AS total FROM peers`
      );
      const obsCount = await pool.query(
        `SELECT COUNT(*) AS count FROM observations WHERE deleted_at IS NULL`
      );
      return {
        active_peers: parseInt(peerStats.rows[0].active),
        total_peers: parseInt(peerStats.rows[0].total),
        total_observations: parseInt(obsCount.rows[0].count),
      };
    },

    /**
     * minder__config — read or write a config key.
     * Declaration marks only `key` as required; absence of `value` is a read.
     */
    config: async (params) => {
      const { key, value } = params || {};
      if (!key) throw bad('EBADPARAM', 'key is required');

      if (value === undefined) {
        const result = await pool.query(
          `SELECT value, updated_at FROM config WHERE key = $1`,
          [key]
        );
        if (result.rows.length === 0) {
          throw bad('CONFIG_KEY_NOT_FOUND', `Config key not found: ${key}`);
        }
        return { key, value: result.rows[0].value, updated_at: result.rows[0].updated_at };
      }

      await pool.query(
        `INSERT INTO config (key, value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
        [key, JSON.stringify(value)]
      );
      return { key, value, status: 'updated' };
    },

    // -----------------------------------------------------------------
    // Dream + analysis (LLM)
    // -----------------------------------------------------------------

    /**
     * minder__dream — trigger dream cycle (4-phase LLM-driven).
     */
    dream: async (params) => {
      const { peer_id = null, force = false } = params || {};
      ensureLLM();
      if (typeof triggerDream !== 'function') {
        throw bad('DREAM_UNAVAILABLE', 'Dream cycle is not wired in this organ instance');
      }
      return triggerDream(peer_id, force);
    },

    /**
     * minder__dream_analysis — LLM analysis of recent observations.
     */
    dreamAnalysis: async (params) => {
      const { peer_id } = params || {};
      if (!peer_id) throw bad('EBADPARAM', 'peer_id is required');
      ensureLLM();

      const peer = await pool.query('SELECT name FROM peers WHERE id = $1', [peer_id]);
      if (peer.rows.length === 0) {
        throw bad('PEER_NOT_FOUND', `Peer not found: ${peer_id}`);
      }

      const stats = await pool.query(
        `SELECT level, COUNT(*) AS count
         FROM observations o
         JOIN collections c ON o.collection_id = c.id
         WHERE c.observed_id = $1 AND o.deleted_at IS NULL
         GROUP BY level`,
        [peer_id]
      );
      const byLevel = {};
      let total = 0;
      for (const row of stats.rows) {
        byLevel[row.level] = parseInt(row.count);
        total += parseInt(row.count);
      }

      const recent = await pool.query(
        `SELECT o.content, o.level, o.confidence
         FROM observations o
         JOIN collections c ON o.collection_id = c.id
         WHERE c.observed_id = $1 AND o.deleted_at IS NULL
         ORDER BY o.created_at DESC LIMIT 30`,
        [peer_id]
      );
      const obsText = recent.rows.map(o => `[${o.level}|${o.confidence}] ${o.content}`).join('\n');

      const response = await agents.dialecticWorker.chat(
        [{ role: 'user', content: `Analyze the dream cycle results for ${peer.rows[0].name}:\n\n${obsText}` }],
        {
          system: 'Provide a concise analysis of the dream cycle observations for this person. Note patterns, gaps, and confidence levels. Max 500 words.',
          thinking: true,
          thinkingBudget: 3000,
        }
      );

      return {
        peer: peer.rows[0].name,
        peer_id,
        analysis: response.content,
        observation_count: total,
        by_level: byLevel,
      };
    },

    /**
     * minder__memory_perception — LLM analysis of a person's card.
     */
    memoryPerception: async (params) => {
      const { peer_id } = params || {};
      if (!peer_id) throw bad('EBADPARAM', 'peer_id is required');
      ensureLLM();

      const peer = await pool.query('SELECT name, card FROM peers WHERE id = $1', [peer_id]);
      if (peer.rows.length === 0) {
        throw bad('PEER_NOT_FOUND', `Peer not found: ${peer_id}`);
      }

      const card = peer.rows[0].card || {};
      const entries = card.entries || [];

      if (entries.length === 0) {
        return {
          peer: peer.rows[0].name,
          peer_id,
          analysis: 'No card entries available for perception analysis.',
          entry_count: 0,
        };
      }

      const cardText = entries.map(e => `[${e.type}] ${e.content}`).join('\n');
      const response = await agents.dialecticWorker.chat(
        [{ role: 'user', content: `Analyze the person card for ${peer.rows[0].name}:\n\n${cardText}` }],
        {
          system: 'Provide a perception analysis of this person based on their card. What patterns emerge? What is the card missing? What stands out? Max 500 words.',
          thinking: true,
          thinkingBudget: 3000,
        }
      );

      const byType = {};
      for (const e of entries) {
        byType[e.type] = (byType[e.type] || 0) + 1;
      }

      return {
        peer: peer.rows[0].name,
        peer_id,
        analysis: response.content,
        entry_count: entries.length,
        dream_cycle: card.dream_cycle || 0,
        by_type: byType,
      };
    },
  };
}
