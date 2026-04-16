/**
 * Configuration routes.
 *
 * GET /config/:key — read a config value
 * PUT /config/:key — write a config value
 */

import { Router } from 'express';

export function createConfigRouter(pool) {
  const router = Router();

  // GET /config/:key
  router.get('/config/:key', async (req, res) => {
    try {
      const { key } = req.params;

      const result = await pool.query('SELECT value, updated_at FROM config WHERE key = $1', [key]);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Config key not found', key });
      }

      res.json({
        key,
        value: result.rows[0].value,
        updated_at: result.rows[0].updated_at,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /config/:key
  // c2a-http-route-03: return the MP-TOOL-1 R7 tool_call_response payload shape
  // so MCP-Router's _callHttp (which wraps the response body as `result`) yields
  // {result:{status:"SUCCESS",data,tool,elapsed_ms,meta}} — the conformance-scan
  // classifier reads result.status and expects a value from the closed enum.
  // Pre-fix shape was {key, value, status:"updated"} which collided with the
  // classifier's result.status probe.
  router.put('/config/:key', async (req, res) => {
    const startTime = Date.now();
    try {
      const { key } = req.params;
      const { value } = req.body;

      await pool.query(`
        INSERT INTO config (key, value, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()
      `, [key, JSON.stringify(value)]);

      res.json({
        status: 'SUCCESS',
        data: { key, value },
        tool: 'minder__config',
        elapsed_ms: Date.now() - startTime,
        meta: { transport: 'http', organ: 'minder' },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
