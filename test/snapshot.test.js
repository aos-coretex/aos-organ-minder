import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createSnapshotRouter } from '../server/routes/snapshot.js';
import { createMockPool } from './helpers.js';

async function request(app, method, path) {
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method });
    const data = await res.json();
    return { status: res.status, data };
  } finally {
    server.close();
  }
}

function mountSnapshot(pool) {
  const app = express();
  app.use('/', createSnapshotRouter(pool));
  return app;
}

describe('Snapshot routes — GET /peers/recent', () => {
  it('returns ordered peers with expected shape', async () => {
    const pool = createMockPool({
      'FROM peers p': {
        rows: [
          {
            peer_id: 'urn:minder:peer:leon',
            name: 'Leon Cohen-Levy',
            peer_type: 'human',
            last_seen: '2026-04-11T20:57:47.000Z',
            observation_count: 42,
            card_entry_count: 40,
          },
          {
            peer_id: 'urn:minder:peer:claude',
            name: 'Claude',
            peer_type: 'persona',
            last_seen: '2026-04-10T18:30:00.000Z',
            observation_count: 7,
            card_entry_count: 3,
          },
        ],
      },
    });

    const { status, data } = await request(mountSnapshot(pool), 'GET', '/peers/recent');

    assert.equal(status, 200);
    assert.equal(data.count, 2);
    assert.equal(data.peers.length, 2);
    assert.equal(data.peers[0].peer_id, 'urn:minder:peer:leon');
    assert.equal(data.peers[0].name, 'Leon Cohen-Levy');
    assert.equal(data.peers[0].peer_type, 'human');
    assert.equal(data.peers[0].last_seen, '2026-04-11T20:57:47.000Z');
    assert.equal(data.peers[0].observation_count, 42);
    assert.equal(data.peers[0].card_entry_count, 40);
    assert.equal(data.peers[1].peer_id, 'urn:minder:peer:claude');
  });

  it('returns 400 for invalid limit values', async () => {
    const pool = createMockPool();
    const app = mountSnapshot(pool);

    const bad = await request(app, 'GET', '/peers/recent?limit=abc');
    assert.equal(bad.status, 400);

    const negative = await request(app, 'GET', '/peers/recent?limit=-1');
    assert.equal(negative.status, 400);

    const tooLarge = await request(app, 'GET', '/peers/recent?limit=1000');
    assert.equal(tooLarge.status, 400);
  });

  it('returns empty payload when no peers match', async () => {
    const pool = createMockPool({
      'FROM peers p': { rows: [] },
    });

    const { status, data } = await request(mountSnapshot(pool), 'GET', '/peers/recent');

    assert.equal(status, 200);
    assert.equal(data.count, 0);
    assert.deepEqual(data.peers, []);
  });

  it('honors explicit limit parameter', async () => {
    const pool = createMockPool({
      'FROM peers p': { rows: [] },
    });

    const { status } = await request(mountSnapshot(pool), 'GET', '/peers/recent?limit=50');
    assert.equal(status, 200);

    const lastQuery = pool.getQueries().slice(-1)[0];
    assert.deepEqual(lastQuery.params, [50]);
  });
});

describe('Snapshot routes — GET /observations/recent', () => {
  it('returns ordered observations with expected shape', async () => {
    const pool = createMockPool({
      'FROM observations o': {
        rows: [
          {
            observation_id: 'urn:minder:observation:abc',
            peer_id: 'urn:minder:peer:leon',
            observation_type: 'explicit',
            content: 'Leon prefers terse architectural replies',
            confidence: 'high',
            created_at: '2026-04-11T19:30:00.000Z',
          },
          {
            observation_id: 'urn:minder:observation:def',
            peer_id: 'urn:minder:peer:leon',
            observation_type: 'deductive',
            content: 'Leon values surgical commits',
            confidence: 'medium',
            created_at: '2026-04-11T18:00:00.000Z',
          },
        ],
      },
    });

    const { status, data } = await request(mountSnapshot(pool), 'GET', '/observations/recent');

    assert.equal(status, 200);
    assert.equal(data.count, 2);
    assert.equal(data.observations.length, 2);
    assert.equal(data.observations[0].observation_id, 'urn:minder:observation:abc');
    assert.equal(data.observations[0].peer_id, 'urn:minder:peer:leon');
    assert.equal(data.observations[0].observation_type, 'explicit');
    assert.equal(data.observations[0].content, 'Leon prefers terse architectural replies');
    assert.equal(data.observations[0].confidence, 'high');
    assert.equal(data.observations[0].created_at, '2026-04-11T19:30:00.000Z');
  });

  it('returns 400 for invalid limit values', async () => {
    const pool = createMockPool();
    const app = mountSnapshot(pool);

    const bad = await request(app, 'GET', '/observations/recent?limit=abc');
    assert.equal(bad.status, 400);

    const negative = await request(app, 'GET', '/observations/recent?limit=-1');
    assert.equal(negative.status, 400);

    const tooLarge = await request(app, 'GET', '/observations/recent?limit=1000');
    assert.equal(tooLarge.status, 400);
  });

  it('returns empty payload when no observations match', async () => {
    const pool = createMockPool({
      'FROM observations o': { rows: [] },
    });

    const { status, data } = await request(mountSnapshot(pool), 'GET', '/observations/recent');

    assert.equal(status, 200);
    assert.equal(data.count, 0);
    assert.deepEqual(data.observations, []);
  });
});
