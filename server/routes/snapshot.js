/**
 * Snapshot read routes.
 *
 * GET /peers/recent?limit=N        — recently active peers ordered by last_seen DESC
 * GET /observations/recent?limit=N — recent observations ordered by created_at DESC
 *
 * Read-only snapshots consumed by the Cortex cm-client world-state reader
 * (lib/cm-client.js::readMinder). No writes, no schema changes.
 *
 * last_seen is derived from MAX(session_peers.joined_at) — the peers table has
 * no direct last_seen column, session_peers.joined_at is the recency proxy
 * Minder already uses elsewhere (see /identify).
 *
 * observations are joined to peers via collections.observed_id since the
 * observations table has no direct peer_id column.
 */

import { Router } from 'express';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function parseLimit(raw) {
  if (raw === undefined) return { limit: DEFAULT_LIMIT };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    return { error: `limit must be an integer between 1 and ${MAX_LIMIT}` };
  }
  return { limit: n };
}

export function createSnapshotRouter(pool) {
  const router = Router();

  // GET /peers/recent
  router.get('/peers/recent', async (req, res) => {
    const parsed = parseLimit(req.query.limit);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    try {
      const result = await pool.query(
        `
        SELECT
          p.id          AS peer_id,
          p.name        AS name,
          p.peer_type   AS peer_type,
          sp.last_seen  AS last_seen,
          obs.observation_count,
          CASE
            WHEN jsonb_typeof(p.card->'entries') = 'array'
              THEN jsonb_array_length(p.card->'entries')
            ELSE 0
          END           AS card_entry_count
        FROM peers p
        LEFT JOIN LATERAL (
          SELECT MAX(joined_at) AS last_seen
          FROM session_peers
          WHERE peer_id = p.id
        ) sp ON TRUE
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS observation_count
          FROM observations o
          JOIN collections c ON o.collection_id = c.id
          WHERE c.observed_id = p.id AND o.deleted_at IS NULL
        ) obs ON TRUE
        WHERE p.status = 'active' AND sp.last_seen IS NOT NULL
        ORDER BY sp.last_seen DESC
        LIMIT $1
        `,
        [parsed.limit],
      );

      const peers = result.rows.map(r => ({
        peer_id: r.peer_id,
        name: r.name,
        peer_type: r.peer_type,
        last_seen: r.last_seen,
        observation_count: r.observation_count ?? 0,
        card_entry_count: r.card_entry_count ?? 0,
      }));

      res.json({ peers, count: peers.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /observations/recent
  router.get('/observations/recent', async (req, res) => {
    const parsed = parseLimit(req.query.limit);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    try {
      const result = await pool.query(
        `
        SELECT
          o.id           AS observation_id,
          c.observed_id  AS peer_id,
          o.level        AS observation_type,
          o.content      AS content,
          o.confidence   AS confidence,
          o.created_at   AS created_at
        FROM observations o
        JOIN collections c ON o.collection_id = c.id
        WHERE o.deleted_at IS NULL
        ORDER BY o.created_at DESC
        LIMIT $1
        `,
        [parsed.limit],
      );

      const observations = result.rows.map(r => ({
        observation_id: r.observation_id,
        peer_id: r.peer_id,
        observation_type: r.observation_type,
        content: r.content,
        confidence: r.confidence,
        created_at: r.created_at,
      }));

      res.json({ observations, count: observations.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
