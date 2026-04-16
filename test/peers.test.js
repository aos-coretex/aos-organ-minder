import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createPeersRouter } from '../server/routes/peers.js';
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

describe('Peer routes', () => {
  it('POST /peers registers a new peer with deterministic URN', async () => {
    const pool = createMockPool({
      'SELECT id, status FROM peers': { rows: [] }, // not existing
      'INSERT INTO peers': { rows: [] },
    });

    const app = express();
    app.use(express.json());
    app.use('/peers', createPeersRouter(pool));

    const { status, data } = await request(app, 'POST', '/peers', {
      name: 'Leon Cohen-Levy',
      peer_type: 'human',
    });

    assert.equal(status, 201);
    // R7 envelope (c2a-http-route-03)
    assert.equal(data.status, 'SUCCESS');
    assert.equal(data.tool, 'minder__register_peer');
    assert.equal(data.meta.transport, 'http');
    assert.equal(data.meta.organ, 'minder');
    assert.ok(typeof data.elapsed_ms === 'number');
    // Payload — peer lifecycle state preserved inside data.peer_status
    assert.equal(data.data.peer_id, 'urn:minder:peer:leon-cohen-levy');
    assert.equal(data.data.name, 'Leon Cohen-Levy');
    assert.equal(data.data.peer_type, 'human');
    assert.equal(data.data.peer_status, 'active');
  });

  it('POST /peers returns 409 when peer already exists', async () => {
    const pool = createMockPool({
      'SELECT id, status FROM peers': { rows: [{ id: 'urn:minder:peer:leon', status: 'active' }] },
    });

    const app = express();
    app.use(express.json());
    app.use('/peers', createPeersRouter(pool));

    const { status, data } = await request(app, 'POST', '/peers', { name: 'Leon' });
    assert.equal(status, 409);
    assert.ok(data.error.includes('already exists'));
  });

  it('POST /peers returns 400 when name is missing', async () => {
    const pool = createMockPool();
    const app = express();
    app.use(express.json());
    app.use('/peers', createPeersRouter(pool));

    const { status } = await request(app, 'POST', '/peers', {});
    assert.equal(status, 400);
  });

  it('DELETE /peers/:peer_id retires a peer', async () => {
    const pool = createMockPool({
      'UPDATE peers': { rows: [{ id: 'urn:minder:peer:leon' }] },
    });

    const app = express();
    app.use(express.json());
    app.use('/peers', createPeersRouter(pool));

    const { status, data } = await request(app, 'DELETE', `/peers/${encodeURIComponent('urn:minder:peer:leon')}`);
    assert.equal(status, 200);
    // R7 envelope (c2a-http-route-03)
    assert.equal(data.status, 'SUCCESS');
    assert.equal(data.tool, 'minder__retire_peer');
    assert.equal(data.meta.transport, 'http');
    assert.equal(data.meta.organ, 'minder');
    assert.ok(typeof data.elapsed_ms === 'number');
    // Payload — peer lifecycle state preserved inside data.peer_status
    assert.equal(data.data.peer_id, 'urn:minder:peer:leon');
    assert.equal(data.data.peer_status, 'retired');
  });
});
