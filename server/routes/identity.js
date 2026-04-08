/**
 * Identity route.
 *
 * POST /identify — identify a person at session start
 */

import { Router } from 'express';

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function createIdentityRouter(pool) {
  const router = Router();

  // POST /identify
  router.post('/identify', async (req, res) => {
    try {
      const { name, code } = req.body;

      if (!name) {
        return res.status(400).json({ error: 'name is required' });
      }

      const peerId = `urn:minder:peer:${slugify(name)}`;

      const peer = await pool.query(
        'SELECT id, name, peer_type, status, card, metadata, created_at FROM peers WHERE id = $1',
        [peerId],
      );

      if (peer.rows.length === 0) {
        return res.json({ status: 'unknown', peer_id: peerId, name });
      }

      const p = peer.rows[0];

      if (p.status === 'retired') {
        return res.json({ status: 'retired', peer_id: peerId, name: p.name });
      }

      // Optional verification code check
      if (code) {
        const meta = p.metadata || {};
        if (meta.verification_code && meta.verification_code !== code) {
          return res.json({ status: 'verification_failed', peer_id: peerId, name: p.name });
        }
      }

      // Register session
      const sessionId = `urn:minder:session:${Date.now()}`;
      await pool.query('INSERT INTO sessions (id) VALUES ($1) ON CONFLICT DO NOTHING', [sessionId]);
      await pool.query(
        'INSERT INTO session_peers (session_id, peer_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [sessionId, peerId],
      );

      // Get card summary
      const card = p.card || {};
      const entries = card.entries || [];
      const topEntries = entries.slice(0, 5);

      // Get last session
      const lastSession = await pool.query(`
        SELECT s.id AS session_id, s.name AS session_name, sp.joined_at
        FROM session_peers sp
        JOIN sessions s ON s.id = sp.session_id
        WHERE sp.peer_id = $1
        ORDER BY sp.joined_at DESC
        LIMIT 1 OFFSET 1
      `, [peerId]);

      res.json({
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
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
