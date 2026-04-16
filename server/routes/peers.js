/**
 * Peer management routes.
 *
 * POST   /peers          — register a new peer
 * DELETE /peers/:peer_id — retire a peer
 */

import { Router } from 'express';

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function createPeersRouter(pool) {
  const router = Router();

  // POST /peers — register a new peer
  // c2a-http-route-03: return the MP-TOOL-1 R7 tool_call_response payload shape
  // so MCP-Router's _callHttp (which wraps the response body as `result`) yields
  // {result:{status:"SUCCESS",data,tool,elapsed_ms,meta}} — the conformance-scan
  // classifier reads result.status and expects a value from the closed enum.
  // Pre-fix shape was {peer_id,name,peer_type,status:"active"} — peer lifecycle
  // state "active" collided with the classifier's result.status probe. The
  // peer's lifecycle state is preserved inside `data.peer_status`.
  router.post('/', async (req, res) => {
    const startTime = Date.now();
    try {
      const { name, peer_type = 'human', entity_urn } = req.body;

      if (!name) {
        return res.status(400).json({ error: 'name is required' });
      }

      const peerId = `urn:minder:peer:${slugify(name)}`;

      // Check if peer already exists
      const existing = await pool.query('SELECT id, status FROM peers WHERE id = $1', [peerId]);
      if (existing.rows.length > 0) {
        if (existing.rows[0].status === 'retired') {
          return res.status(409).json({ error: 'Peer is retired', peer_id: peerId });
        }
        return res.status(409).json({ error: 'Peer already exists', peer_id: peerId });
      }

      await pool.query(`
        INSERT INTO peers (id, name, peer_type, status, entity_urn)
        VALUES ($1, $2, $3, 'active', $4)
      `, [peerId, name, peer_type, entity_urn || null]);

      res.status(201).json({
        status: 'SUCCESS',
        data: {
          peer_id: peerId,
          name,
          peer_type,
          peer_status: 'active',
        },
        tool: 'minder__register_peer',
        elapsed_ms: Date.now() - startTime,
        meta: { transport: 'http', organ: 'minder' },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /peers/:peer_id — retire a peer
  // c2a-http-route-03: R7 payload shape (see POST /peers comment above).
  // The peer's lifecycle state "retired" is preserved inside `data.peer_status`.
  router.delete('/:peer_id', async (req, res) => {
    const startTime = Date.now();
    try {
      const peerId = decodeURIComponent(req.params.peer_id);

      const result = await pool.query(`
        UPDATE peers SET status = 'retired', retired_at = NOW()
        WHERE id = $1 AND status = 'active'
        RETURNING id
      `, [peerId]);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Peer not found or already retired' });
      }

      res.json({
        status: 'SUCCESS',
        data: {
          peer_id: peerId,
          peer_status: 'retired',
        },
        tool: 'minder__retire_peer',
        elapsed_ms: Date.now() - startTime,
        meta: { transport: 'http', organ: 'minder' },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
