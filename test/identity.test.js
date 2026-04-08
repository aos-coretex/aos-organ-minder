import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createIdentityRouter } from '../server/routes/identity.js';
import { createMockPool } from './helpers.js';

async function request(app, method, path, body) {
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`http://127.0.0.1:${port}${path}`, opts);
    const data = await res.json();
    return { status: res.status, data };
  } finally {
    server.close();
  }
}

describe('Identity routes', () => {
  it('POST /identify returns identified status for known peer', async () => {
    const pool = createMockPool({
      'SELECT id, name, peer_type, status, card, metadata, created_at FROM peers': {
        rows: [{
          id: 'urn:minder:peer:leon-cohen-levy',
          name: 'Leon Cohen-Levy',
          peer_type: 'human',
          status: 'active',
          card: {
            entries: [
              { type: 'FACT', content: 'Builds distributed systems', confidence: 'high', source_count: 5 },
            ],
            dream_cycle: 10,
            last_updated: '2026-04-07T10:00:00Z',
          },
          metadata: {},
          created_at: '2026-03-29T18:00:00Z',
        }],
      },
      'INSERT INTO sessions': { rows: [] },
      'INSERT INTO session_peers': { rows: [] },
      'SELECT s.id': { rows: [] }, // no previous session
    });

    const app = express();
    app.use(express.json());
    app.use('/', createIdentityRouter(pool));

    const { status, data } = await request(app, 'POST', '/identify', {
      name: 'Leon Cohen-Levy',
    });

    assert.equal(status, 200);
    assert.equal(data.status, 'identified');
    assert.equal(data.peer_id, 'urn:minder:peer:leon-cohen-levy');
    assert.equal(data.card_summary.total_entries, 1);
    assert.equal(data.card_summary.dream_cycle, 10);
  });

  it('POST /identify returns unknown for unregistered peer', async () => {
    const pool = createMockPool({
      'SELECT id, name, peer_type, status, card, metadata, created_at FROM peers': { rows: [] },
    });

    const app = express();
    app.use(express.json());
    app.use('/', createIdentityRouter(pool));

    const { status, data } = await request(app, 'POST', '/identify', {
      name: 'Unknown Person',
    });

    assert.equal(status, 200);
    assert.equal(data.status, 'unknown');
  });

  it('POST /identify returns retired for retired peer', async () => {
    const pool = createMockPool({
      'SELECT id, name, peer_type, status, card, metadata, created_at FROM peers': {
        rows: [{
          id: 'urn:minder:peer:old',
          name: 'Old Peer',
          peer_type: 'persona',
          status: 'retired',
          card: null,
          metadata: null,
          created_at: '2026-01-01T00:00:00Z',
        }],
      },
    });

    const app = express();
    app.use(express.json());
    app.use('/', createIdentityRouter(pool));

    const { status, data } = await request(app, 'POST', '/identify', { name: 'Old Peer' });
    assert.equal(status, 200);
    assert.equal(data.status, 'retired');
  });
});
