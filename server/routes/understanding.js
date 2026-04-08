/**
 * Person understanding routes.
 *
 * GET  /peers/:peer_id/card           — current person card
 * GET  /peers/:peer_id/representation — full representation with observation stats
 * POST /query                         — natural language query about a person
 * POST /search                        — semantic vector search across observations
 */

import { Router } from 'express';

export function createUnderstandingRouter(pool, agents, vectr) {
  const router = Router();

  // GET /peers/:peer_id/card
  router.get('/peers/:peer_id/card', async (req, res) => {
    try {
      const peerId = decodeURIComponent(req.params.peer_id);

      const result = await pool.query(
        'SELECT id, name, peer_type, status, card, created_at FROM peers WHERE id = $1',
        [peerId],
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'PEER_NOT_FOUND', peer_id: peerId });
      }

      const peer = result.rows[0];
      const card = peer.card || {};
      const entries = card.entries || [];

      res.json({
        peer_id: peer.id,
        name: peer.name,
        peer_type: peer.peer_type,
        status: peer.status,
        card: entries,
        card_entries: entries.length,
        created_at: peer.created_at,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /peers/:peer_id/representation
  router.get('/peers/:peer_id/representation', async (req, res) => {
    try {
      const peerId = decodeURIComponent(req.params.peer_id);

      const peer = await pool.query('SELECT * FROM peers WHERE id = $1', [peerId]);
      if (peer.rows.length === 0) {
        return res.status(404).json({ error: 'PEER_NOT_FOUND' });
      }

      const p = peer.rows[0];
      const card = p.card || {};

      // Observation counts by level
      const obsStats = await pool.query(`
        SELECT level, COUNT(*) AS count
        FROM observations o
        JOIN collections c ON o.collection_id = c.id
        WHERE c.observed_id = $1 AND o.deleted_at IS NULL
        GROUP BY level
      `, [peerId]);

      const byLevel = {};
      let total = 0;
      for (const row of obsStats.rows) {
        byLevel[row.level] = parseInt(row.count);
        total += parseInt(row.count);
      }

      // Observer count
      const observers = await pool.query(`
        SELECT COUNT(DISTINCT c.observer_id) AS count
        FROM collections c
        JOIN observations o ON o.collection_id = c.id
        WHERE c.observed_id = $1 AND o.deleted_at IS NULL
      `, [peerId]);

      res.json({
        peer_id: p.id,
        name: p.name,
        card: card.entries || [],
        observations_by_level: byLevel,
        total_observations: total,
        observer_count: parseInt(observers.rows[0].count),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /query — natural language query about a person
  router.post('/query', async (req, res) => {
    try {
      const { peer_id, question, observer_id, limit = 10 } = req.body;

      if (!peer_id || !question) {
        return res.status(400).json({ error: 'peer_id and question are required' });
      }

      if (!agents.isAvailable()) {
        return res.status(503).json({ error: 'LLM unavailable' });
      }

      // Load card
      const peer = await pool.query('SELECT name, card FROM peers WHERE id = $1', [peer_id]);
      if (peer.rows.length === 0) {
        return res.status(404).json({ error: 'PEER_NOT_FOUND' });
      }

      const card = peer.rows[0].card || {};
      const cardEntries = card.entries || [];

      // Load relevant observations
      let obsQuery = `
        SELECT o.id, o.content, o.level, o.confidence
        FROM observations o
        JOIN collections c ON o.collection_id = c.id
        WHERE c.observed_id = $1 AND o.deleted_at IS NULL
      `;
      const params = [peer_id];
      let idx = 2;

      if (observer_id) {
        obsQuery += ` AND c.observer_id = $${idx}`;
        params.push(observer_id);
        idx++;
      }

      obsQuery += ` ORDER BY o.created_at DESC LIMIT $${idx}`;
      params.push(parseInt(limit));

      const obs = await pool.query(obsQuery, params);

      // Build context for dialectic worker
      const cardText = cardEntries.map(e => `[${e.type}] ${e.content}`).join('\n');
      const obsText = obs.rows.map(o => `[${o.level}|${o.confidence}] ${o.content}`).join('\n');

      const context = `Person: ${peer.rows[0].name}\n\nCard:\n${cardText}\n\nObservations:\n${obsText}`;

      const response = await agents.dialecticWorker.chat(
        [{ role: 'user', content: `Question: ${question}\n\n${context}` }],
        {
          system: 'You are a person understanding agent. Answer the question about this person using the provided card and observations. Be concise (max 1024 tokens). Cite observation IDs when relevant.',
          thinking: true,
          thinkingBudget: 5000,
        },
      );

      res.json({
        answer: response.content,
        sources: obs.rows.map(o => o.id),
        observation_count: obs.rows.length,
        peer: peer.rows[0].name,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /search — semantic search across observations
  router.post('/search', async (req, res) => {
    try {
      const { query, peer_id, level, limit = 10 } = req.body;

      if (!query) {
        return res.status(400).json({ error: 'query is required' });
      }

      const embedding = await vectr.embed(query);
      if (!embedding) {
        return res.status(503).json({ error: 'EMBEDDING_UNAVAILABLE' });
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
      const params = [JSON.stringify(embedding)];
      let idx = 2;

      if (peer_id) {
        sql += ` AND c.observed_id = $${idx}`;
        params.push(peer_id);
        idx++;
      }

      if (level) {
        sql += ` AND o.level = $${idx}`;
        params.push(level);
        idx++;
      }

      sql += ` ORDER BY similarity DESC LIMIT $${idx}`;
      params.push(parseInt(limit));

      const result = await pool.query(sql, params);

      res.json({
        results: result.rows.map(r => ({
          id: r.id,
          content: r.content,
          level: r.level,
          confidence: r.confidence,
          times_derived: r.times_derived,
          similarity: parseFloat(r.similarity),
          created_at: r.created_at,
        })),
        count: result.rows.length,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
