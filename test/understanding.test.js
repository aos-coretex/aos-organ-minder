import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createUnderstandingRouter } from '../server/routes/understanding.js';
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

describe('Understanding routes', () => {
  it('GET /peers/:peer_id/card returns card entries', async () => {
    const pool = createMockPool({
      'SELECT id, name, peer_type, status, card, created_at FROM peers': {
        rows: [{
          id: 'urn:minder:peer:leon',
          name: 'Leon',
          peer_type: 'human',
          status: 'active',
          card: {
            entries: [
              { type: 'FACT', content: 'Builds distributed systems', confidence: 'high', source_count: 5 },
              { type: 'TRAIT', content: 'Systems thinker', confidence: 'high', source_count: 3 },
            ],
          },
          created_at: '2026-03-29T18:00:00Z',
        }],
      },
    });

    const app = express();
    app.use(express.json());
    app.use('/', createUnderstandingRouter(pool, createMockAgents(false), createMockVectr(null)));

    const { status, data } = await request(app, 'GET', `/peers/${encodeURIComponent('urn:minder:peer:leon')}/card`);

    assert.equal(status, 200);
    assert.equal(data.name, 'Leon');
    assert.equal(data.card_entries, 2);
    assert.equal(data.card[0].type, 'FACT');
  });

  it('GET /peers/:peer_id/card returns 404 for unknown peer', async () => {
    const pool = createMockPool({
      'SELECT id, name, peer_type, status, card, created_at FROM peers': { rows: [] },
    });

    const app = express();
    app.use(express.json());
    app.use('/', createUnderstandingRouter(pool, createMockAgents(false), createMockVectr(null)));

    const { status } = await request(app, 'GET', `/peers/${encodeURIComponent('urn:minder:peer:unknown')}/card`);
    assert.equal(status, 404);
  });

  it('POST /query returns 503 when LLM unavailable', async () => {
    const pool = createMockPool();
    const agents = createMockAgents(false); // LLM unavailable

    const app = express();
    app.use(express.json());
    app.use('/', createUnderstandingRouter(pool, agents, createMockVectr(null)));

    const { status, data } = await request(app, 'POST', '/query', {
      peer_id: 'urn:minder:peer:leon',
      question: 'What languages does Leon use?',
    });

    assert.equal(status, 503);
    assert.equal(data.error, 'LLM unavailable');
  });
});
