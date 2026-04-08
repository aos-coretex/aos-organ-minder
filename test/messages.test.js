import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMessageHandler } from '../server/handlers/messages.js';
import { createMockPool, createMockAgents, createMockVectr } from './helpers.js';

describe('Spine message handler', () => {
  it('routes identify event and returns response', async () => {
    const pool = createMockPool({
      'SELECT id, name, peer_type, status, card, created_at FROM peers': {
        rows: [{
          id: 'urn:minder:peer:leon',
          name: 'Leon',
          peer_type: 'human',
          status: 'active',
          card: { entries: [], dream_cycle: 5 },
          created_at: '2026-03-29T18:00:00Z',
        }],
      },
    });
    const agents = createMockAgents(false);
    const vectr = createMockVectr(null);
    const handler = createMessageHandler(pool, agents, vectr, null);

    const result = await handler({
      message_id: 'otm-001',
      payload: { event_type: 'identify', name: 'Leon' },
    });

    assert.equal(result.event_type, 'identify_response');
    assert.equal(result.status, 'identified');
    assert.equal(result.peer_id, 'urn:minder:peer:leon');
  });

  it('routes ingest event and stores messages', async () => {
    const pool = createMockPool();
    // Override query to handle all insert patterns
    pool.query = async (sql, params) => {
      pool.getQueries().push({ sql, params });
      return { rows: [] };
    };

    const agents = createMockAgents(false);
    const vectr = createMockVectr(null);
    const handler = createMessageHandler(pool, agents, vectr, null);

    const result = await handler({
      message_id: 'otm-002',
      payload: {
        event_type: 'ingest',
        peer_id: 'urn:minder:peer:leon',
        messages: [{ content: 'Test message' }],
      },
    });

    assert.equal(result.event_type, 'ingest_response');
    assert.equal(result.messages_ingested, 1);
  });

  it('routes dream_trigger and returns disabled when no handler', async () => {
    const pool = createMockPool();
    const agents = createMockAgents(false);
    const vectr = createMockVectr(null);
    const handler = createMessageHandler(pool, agents, vectr, null);

    const result = await handler({
      message_id: 'otm-003',
      payload: { event_type: 'dream_trigger' },
    });

    assert.equal(result.event_type, 'dream_response');
    assert.equal(result.status, 'dream_disabled');
  });

  it('routes card event and returns card data', async () => {
    const pool = createMockPool({
      'SELECT name, card FROM peers': {
        rows: [{
          name: 'Leon',
          card: { entries: [{ type: 'FACT', content: 'Test fact' }] },
        }],
      },
    });
    const agents = createMockAgents(false);
    const vectr = createMockVectr(null);
    const handler = createMessageHandler(pool, agents, vectr, null);

    const result = await handler({
      message_id: 'otm-004',
      payload: { event_type: 'card', peer_id: 'urn:minder:peer:leon' },
    });

    assert.equal(result.event_type, 'card_response');
    assert.equal(result.card_entries, 1);
  });

  it('returns error for unknown event type', async () => {
    const pool = createMockPool();
    const agents = createMockAgents(false);
    const vectr = createMockVectr(null);
    const handler = createMessageHandler(pool, agents, vectr, null);

    const result = await handler({
      message_id: 'otm-005',
      payload: { event_type: 'nonexistent' },
    });

    assert.equal(result.error, 'unknown_event_type');
  });
});
