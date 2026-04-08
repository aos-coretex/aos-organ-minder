/**
 * PostgreSQL connection pool for the Minder organ.
 *
 * Connects to the existing `minder` database on localhost:5432.
 * Does NOT create tables — verifies schema at startup.
 */

import pg from 'pg';

const { Pool } = pg;

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

export function createPool(dbConfig) {
  return new Pool(dbConfig);
}

/**
 * Verify the database schema exists.
 */
export async function verifySchema(pool) {
  const client = await pool.connect();
  try {
    await client.query("CREATE EXTENSION IF NOT EXISTS vector");

    const requiredTables = ['peers', 'sessions', 'session_peers', 'messages', 'collections', 'observations', 'queue', 'active_tasks', 'config'];
    for (const table of requiredTables) {
      const check = await client.query(`
        SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = $1) AS exists
      `, [table]);
      if (!check.rows[0].exists) {
        throw new Error(`Table ${table} does not exist — database not initialized`);
      }
    }

    // Log counts
    const peerCount = await client.query("SELECT COUNT(*) AS count FROM peers WHERE status = 'active'");
    const obsCount = await client.query('SELECT COUNT(*) AS count FROM observations WHERE deleted_at IS NULL');
    const queueCount = await client.query("SELECT COUNT(*) AS count FROM queue WHERE status = 'pending'");

    log('minder_db_verified', {
      active_peers: parseInt(peerCount.rows[0].count),
      observations: parseInt(obsCount.rows[0].count),
      queue_pending: parseInt(queueCount.rows[0].count),
    });

    return {
      active_peers: parseInt(peerCount.rows[0].count),
      observations: parseInt(obsCount.rows[0].count),
      queue_pending: parseInt(queueCount.rows[0].count),
    };
  } finally {
    client.release();
  }
}

export async function checkDb(pool) {
  try {
    await pool.query('SELECT 1');
    return 'ok';
  } catch {
    return 'down';
  }
}
