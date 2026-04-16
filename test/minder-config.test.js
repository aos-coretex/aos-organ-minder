/**
 * minder-config route tests — GET /config/:key and PUT /config/:key.
 * Added by c2a-http-route-03 to cover the R7 payload-shape contract on the
 * PUT success path (the route had no prior test coverage).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createConfigRouter } from '../server/routes/minder-config.js';
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

describe('Config routes', () => {
  it('PUT /config/:key upserts and returns R7 payload shape', async () => {
    const pool = createMockPool({
      'INSERT INTO config': { rows: [] },
    });

    const app = express();
    app.use(express.json());
    app.use('/', createConfigRouter(pool));

    const { status, data } = await request(app, 'PUT', '/config/test-key', { value: 42 });

    assert.equal(status, 200);
    // R7 envelope (c2a-http-route-03)
    assert.equal(data.status, 'SUCCESS');
    assert.equal(data.tool, 'minder__config');
    assert.equal(data.meta.transport, 'http');
    assert.equal(data.meta.organ, 'minder');
    assert.ok(typeof data.elapsed_ms === 'number');
    // Payload
    assert.equal(data.data.key, 'test-key');
    assert.equal(data.data.value, 42);
  });

  it('GET /config/:key returns value when key exists', async () => {
    const pool = createMockPool({
      'SELECT value, updated_at FROM config': {
        rows: [{ value: { foo: 'bar' }, updated_at: '2026-04-15T00:00:00Z' }],
      },
    });

    const app = express();
    app.use(express.json());
    app.use('/', createConfigRouter(pool));

    const { status, data } = await request(app, 'GET', '/config/existing-key');

    assert.equal(status, 200);
    assert.equal(data.key, 'existing-key');
    assert.deepEqual(data.value, { foo: 'bar' });
  });

  it('GET /config/:key returns 404 when key missing', async () => {
    const pool = createMockPool({
      'SELECT value, updated_at FROM config': { rows: [] },
    });

    const app = express();
    app.use(express.json());
    app.use('/', createConfigRouter(pool));

    const { status } = await request(app, 'GET', '/config/missing-key');
    assert.equal(status, 404);
  });
});
