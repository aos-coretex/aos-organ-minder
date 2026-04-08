import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createIngestRouter } from '../server/routes/ingest.js';
import { createMockPool, createMockAgents, createMockVectr } from './helpers.js';

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

describe('Ingest routes', () => {
  it('POST /ingest stores messages and returns session info', async () => {
    const pool = createMockPool({
      "SELECT id FROM peers": { rows: [{ id: 'urn:minder:peer:leon' }] },
      'INSERT INTO sessions': { rows: [] },
      'INSERT INTO session_peers': { rows: [] },
      'INSERT INTO messages': { rows: [] },
      'SELECT COALESCE': { rows: [{ total: '500' }] },
    });
    const agents = createMockAgents(false);
    const vectr = createMockVectr(null);

    const app = express();
    app.use(express.json());
    app.use('/', createIngestRouter(pool, agents, vectr, 1000));

    const { status, data } = await request(app, 'POST', '/ingest', {
      peer_id: 'urn:minder:peer:leon',
      messages: [
        { content: 'I work with distributed systems' },
        { content: 'Erlang is my primary language' },
      ],
    });

    assert.equal(status, 200);
    assert.equal(data.messages_ingested, 2);
    assert.ok(data.session_id);
    assert.equal(data.derive_queued, false); // 500 tokens < 1000 threshold
  });

  it('POST /ingest returns 404 for unknown peer', async () => {
    const pool = createMockPool({
      "SELECT id FROM peers": { rows: [] },
    });
    const agents = createMockAgents(false);
    const vectr = createMockVectr(null);

    const app = express();
    app.use(express.json());
    app.use('/', createIngestRouter(pool, agents, vectr, 1000));

    const { status, data } = await request(app, 'POST', '/ingest', {
      peer_id: 'urn:minder:peer:unknown',
      messages: [{ content: 'hello' }],
    });

    assert.equal(status, 404);
    assert.equal(data.error, 'PEER_NOT_FOUND');
  });

  it('POST /ingest returns 400 when messages missing', async () => {
    const pool = createMockPool();
    const agents = createMockAgents(false);
    const vectr = createMockVectr(null);

    const app = express();
    app.use(express.json());
    app.use('/', createIngestRouter(pool, agents, vectr, 1000));

    const { status } = await request(app, 'POST', '/ingest', { peer_id: 'urn:minder:peer:leon' });
    assert.equal(status, 400);
  });
});
