/**
 * Stats route — system-wide statistics.
 *
 * GET /stats
 */

import { Router } from 'express';

export function createStatsRouter(pool, getDreamState) {
  const router = Router();

  router.get('/stats', async (req, res) => {
    try {
      // Peer counts
      const peerStats = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE peer_type = 'human' AND status = 'active') AS human_active,
          COUNT(*) FILTER (WHERE peer_type = 'persona' AND status = 'active') AS persona_active,
          COUNT(*) FILTER (WHERE status = 'retired') AS retired,
          COUNT(*) AS total
        FROM peers
      `);
      const ps = peerStats.rows[0];

      // Observation counts by level
      const obsStats = await pool.query(`
        SELECT level, COUNT(*) AS count
        FROM observations WHERE deleted_at IS NULL
        GROUP BY level
      `);
      const byLevel = {};
      let totalObs = 0;
      for (const row of obsStats.rows) {
        byLevel[row.level] = parseInt(row.count);
        totalObs += parseInt(row.count);
      }

      // Queue depth
      const queueStats = await pool.query(`
        SELECT task_type, COUNT(*) AS count
        FROM queue WHERE status = 'pending'
        GROUP BY task_type
      `);
      const queuePending = {};
      for (const row of queueStats.rows) {
        queuePending[row.task_type] = parseInt(row.count);
      }

      // Message and session counts
      const msgCount = await pool.query('SELECT COUNT(*) AS count FROM messages');
      const sessCount = await pool.query('SELECT COUNT(*) AS count FROM sessions');

      // Config values
      const dreamState = getDreamState();

      res.json({
        peers: {
          human_active: parseInt(ps.human_active),
          persona_active: parseInt(ps.persona_active),
          retired: parseInt(ps.retired),
        },
        total_peers: parseInt(ps.total),
        observations_by_level: byLevel,
        total_observations: totalObs,
        queue_pending: queuePending,
        message_count: parseInt(msgCount.rows[0].count),
        session_count: parseInt(sessCount.rows[0].count),
        config: {
          dream_cycle: dreamState?.cycleNumber || 0,
          dream_enabled: dreamState?.enabled || false,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
