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
  router.put('/config/:key', async (req, res) => {
    try {
      const { key } = req.params;
      const { value } = req.body;

      await pool.query(`
        INSERT INTO config (key, value, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()
      `, [key, JSON.stringify(value)]);

      res.json({ key, value, status: 'updated' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
