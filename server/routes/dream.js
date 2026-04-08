/**
 * Dream and analysis routes.
 *
 * POST /dream                          — trigger dream cycle
 * GET  /peers/:peer_id/dream-analysis  — LLM analysis of dream results
 * GET  /peers/:peer_id/perception      — LLM perception analysis of card
 */

import { Router } from 'express';

export function createDreamRouter(pool, agents, triggerDream) {
  const router = Router();

  // POST /dream — trigger dream cycle
  router.post('/dream', async (req, res) => {
    try {
      const { peer_id, force = false } = req.body;

      if (!agents.isAvailable()) {
        return res.status(503).json({ error: 'LLM unavailable — dream cycle requires LLM agents' });
      }

      const result = await triggerDream(peer_id, force);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /peers/:peer_id/dream-analysis
  router.get('/peers/:peer_id/dream-analysis', async (req, res) => {
    try {
      const peerId = decodeURIComponent(req.params.peer_id);

      if (!agents.isAvailable()) {
        return res.status(503).json({ error: 'LLM unavailable' });
      }

      const peer = await pool.query('SELECT name FROM peers WHERE id = $1', [peerId]);
      if (peer.rows.length === 0) {
        return res.status(404).json({ error: 'PEER_NOT_FOUND' });
      }

      // Load observation stats
      const stats = await pool.query(`
        SELECT level, COUNT(*) AS count
        FROM observations o
        JOIN collections c ON o.collection_id = c.id
        WHERE c.observed_id = $1 AND o.deleted_at IS NULL
        GROUP BY level
      `, [peerId]);

      const byLevel = {};
      let total = 0;
      for (const row of stats.rows) {
        byLevel[row.level] = parseInt(row.count);
        total += parseInt(row.count);
      }

      // Get recent observations for analysis
      const recent = await pool.query(`
        SELECT o.content, o.level, o.confidence
        FROM observations o
        JOIN collections c ON o.collection_id = c.id
        WHERE c.observed_id = $1 AND o.deleted_at IS NULL
        ORDER BY o.created_at DESC LIMIT 30
      `, [peerId]);

      const obsText = recent.rows.map(o => `[${o.level}|${o.confidence}] ${o.content}`).join('\n');

      const response = await agents.dialecticWorker.chat(
        [{ role: 'user', content: `Analyze the dream cycle results for ${peer.rows[0].name}:\n\n${obsText}` }],
        {
          system: 'Provide a concise analysis of the dream cycle observations for this person. Note patterns, gaps, and confidence levels. Max 500 words.',
          thinking: true,
          thinkingBudget: 3000,
        },
      );

      res.json({
        peer: peer.rows[0].name,
        peer_id: peerId,
        analysis: response.content,
        observation_count: total,
        by_level: byLevel,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /peers/:peer_id/perception
  router.get('/peers/:peer_id/perception', async (req, res) => {
    try {
      const peerId = decodeURIComponent(req.params.peer_id);

      if (!agents.isAvailable()) {
        return res.status(503).json({ error: 'LLM unavailable' });
      }

      const peer = await pool.query('SELECT name, card FROM peers WHERE id = $1', [peerId]);
      if (peer.rows.length === 0) {
        return res.status(404).json({ error: 'PEER_NOT_FOUND' });
      }

      const card = peer.rows[0].card || {};
      const entries = card.entries || [];

      if (entries.length === 0) {
        return res.json({
          peer: peer.rows[0].name,
          peer_id: peerId,
          analysis: 'No card entries available for perception analysis.',
          entry_count: 0,
        });
      }

      const cardText = entries.map(e => `[${e.type}] ${e.content}`).join('\n');

      const response = await agents.dialecticWorker.chat(
        [{ role: 'user', content: `Analyze the person card for ${peer.rows[0].name}:\n\n${cardText}` }],
        {
          system: 'Provide a perception analysis of this person based on their card. What patterns emerge? What is the card missing? What stands out? Max 500 words.',
          thinking: true,
          thinkingBudget: 3000,
        },
      );

      // Count by type
      const byType = {};
      for (const e of entries) {
        byType[e.type] = (byType[e.type] || 0) + 1;
      }

      res.json({
        peer: peer.rows[0].name,
        peer_id: peerId,
        analysis: response.content,
        entry_count: entries.length,
        dream_cycle: card.dream_cycle || 0,
        by_type: byType,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
