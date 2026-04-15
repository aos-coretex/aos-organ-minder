/**
 * Minder tool methods — MP-TOOL-1 relay t8r-4.
 *
 * Coverage:
 *   - 14 methods exist
 *   - Non-LLM methods: param validation + SQL shape + error codes
 *   - LLM-dependent methods (5): each one explicitly tested for
 *     `llm_unavailable` when `agents.isAvailable()` returns false (D5 + #20)
 *   - Edge cases: derive batch empty, ingest threshold, config read vs write
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createToolMethods } from '../server/tool-methods.js';
import { createMockPool, createMockAgents, createMockVectr, fakeEmbedding } from './helpers.js';

const LLM_METHODS = ['query', 'derive', 'dream', 'dreamAnalysis', 'memoryPerception'];

function makeDeps(overrides = {}) {
  return {
    pool: overrides.pool ?? createMockPool({
      // More-specific patterns FIRST — mock iterates in insertion order.
      'COALESCE(SUM(token_count)': { rows: [{ total: '0' }] },
      'SELECT id, name, peer_type, status, card, metadata': {
        rows: [{
          id: 'urn:minder:peer:leon',
          name: 'Leon',
          peer_type: 'human',
          status: 'active',
          card: { entries: [{ type: 'trait', content: 'systems thinker' }], dream_cycle: 3 },
          metadata: {},
          created_at: '2026-04-01T00:00:00Z',
        }],
      },
      'SELECT id, name, peer_type, status, card, created_at': {
        rows: [{
          id: 'urn:minder:peer:leon',
          name: 'Leon',
          peer_type: 'human',
          status: 'active',
          card: { entries: [{ type: 'trait', content: 'systems thinker' }], dream_cycle: 3 },
          created_at: '2026-04-01T00:00:00Z',
        }],
      },
      'SELECT id FROM peers WHERE id = $1 AND status': { rows: [{ id: 'urn:minder:peer:leon' }] },
      'SELECT id, status FROM peers WHERE id': { rows: [] },
      'SELECT name, card FROM peers': {
        rows: [{ name: 'Leon', card: { entries: [{ type: 'trait', content: 't' }] } }],
      },
      'SELECT name FROM peers WHERE id': { rows: [{ name: 'Leon' }] },
      'FROM observations o': { rows: [{ level: 'explicit', count: '2' }] },
      'FROM queue': { rows: [] },
      'FROM messages': { rows: [] },
      'COUNT(DISTINCT c.observer_id)': { rows: [{ count: '1' }] },
      'FILTER (WHERE status': { rows: [{ active: '1', total: '2' }] },
      'FROM observations WHERE deleted_at': { rows: [{ count: '0' }] },
      'FROM config': { rows: [{ value: { foo: 'bar' }, updated_at: '2026-04-01T00:00:00Z' }] },
      'JOIN collections c ON o.collection_id': { rows: [] },
      'INSERT INTO sessions': { rows: [] },
      'INSERT INTO session_peers': { rows: [] },
      'INSERT INTO messages': { rows: [] },
      'UPDATE peers': { rows: [{ id: 'urn:minder:peer:leon' }] },
      'INSERT INTO peers': { rows: [] },
    }),
    vectr: overrides.vectr ?? createMockVectr(fakeEmbedding()),
    agents: overrides.agents ?? createMockAgents(true),
    triggerDream: 'triggerDream' in overrides
      ? overrides.triggerDream
      : (async () => ({ status: 'complete', cycle_number: 1 })),
    deriveTokenThreshold: overrides.deriveTokenThreshold ?? 1000,
  };
}

describe('Minder tool-methods — inventory', () => {
  it('exposes exactly the 14 declared methods', () => {
    const methods = createToolMethods(makeDeps());
    const expected = [
      'identify', 'registerPeer', 'retirePeer', 'ingest', 'derive',
      'query', 'search', 'getCard', 'getRepresentation',
      'stats', 'config', 'dream', 'dreamAnalysis', 'memoryPerception',
    ];
    for (const name of expected) {
      assert.equal(typeof methods[name], 'function', `methods.${name} missing`);
    }
    assert.equal(Object.keys(methods).length, expected.length);
  });
});

describe('Minder tool-methods — LLM unavailable (D5 + #20)', () => {
  for (const name of LLM_METHODS) {
    it(`${name} → llm_unavailable when agents.isAvailable() is false`, async () => {
      const methods = createToolMethods(makeDeps({ agents: createMockAgents(false) }));

      // Minimal valid params for each method to pass pre-LLM validation.
      const params = {
        query: { peer_id: 'urn:minder:peer:leon', question: 'q' },
        derive: {},
        dream: {},
        dreamAnalysis: { peer_id: 'urn:minder:peer:leon' },
        memoryPerception: { peer_id: 'urn:minder:peer:leon' },
      }[name];

      await assert.rejects(
        () => methods[name](params),
        (err) => err.code === 'llm_unavailable'
      );
    });
  }
});

describe('Minder tool-methods — non-LLM behavior', () => {
  it('identify rejects missing name with EBADPARAM', async () => {
    const methods = createToolMethods(makeDeps());
    await assert.rejects(() => methods.identify({}), (err) => err.code === 'EBADPARAM');
  });

  it('identify returns status=unknown when peer does not exist', async () => {
    const methods = createToolMethods(makeDeps({
      pool: createMockPool({
        'FROM peers WHERE id': { rows: [] },
        'INSERT INTO sessions': { rows: [] },
      }),
    }));
    const res = await methods.identify({ name: 'Nobody' });
    assert.equal(res.status, 'unknown');
    assert.equal(res.peer_id, 'urn:minder:peer:nobody');
  });

  it('identify returns status=identified for active peer', async () => {
    const methods = createToolMethods(makeDeps());
    const res = await methods.identify({ name: 'Leon' });
    assert.equal(res.status, 'identified');
    assert.equal(res.peer_id, 'urn:minder:peer:leon');
    assert.equal(res.card_summary.total_entries, 1);
  });

  it('registerPeer throws PEER_EXISTS when peer already active', async () => {
    const methods = createToolMethods(makeDeps({
      pool: createMockPool({
        'SELECT id, status FROM peers WHERE id': {
          rows: [{ id: 'urn:minder:peer:leon', status: 'active' }],
        },
      }),
    }));
    await assert.rejects(
      () => methods.registerPeer({ name: 'Leon' }),
      (err) => err.code === 'PEER_EXISTS'
    );
  });

  it('registerPeer creates new peer', async () => {
    const methods = createToolMethods(makeDeps());
    const res = await methods.registerPeer({ name: 'New Person' });
    assert.equal(res.status, 'active');
    assert.equal(res.peer_id, 'urn:minder:peer:new-person');
  });

  it('retirePeer throws PEER_NOT_FOUND for unknown or already-retired', async () => {
    const methods = createToolMethods(makeDeps({
      pool: createMockPool({ 'UPDATE peers': { rows: [] } }),
    }));
    await assert.rejects(
      () => methods.retirePeer({ peer_id: 'urn:minder:peer:nobody' }),
      (err) => err.code === 'PEER_NOT_FOUND'
    );
  });

  it('ingest rejects empty messages', async () => {
    const methods = createToolMethods(makeDeps());
    await assert.rejects(
      () => methods.ingest({ peer_id: 'urn:minder:peer:leon', messages: [] }),
      (err) => err.code === 'EBADPARAM'
    );
  });

  it('ingest throws PEER_NOT_FOUND for inactive peer', async () => {
    const methods = createToolMethods(makeDeps({
      pool: createMockPool({ 'SELECT id FROM peers WHERE id = $1 AND status': { rows: [] } }),
    }));
    await assert.rejects(
      () => methods.ingest({
        peer_id: 'urn:minder:peer:gone',
        messages: [{ content: 'hi' }],
      }),
      (err) => err.code === 'PEER_NOT_FOUND'
    );
  });

  it('ingest records messages and returns token count', async () => {
    const methods = createToolMethods(makeDeps());
    const res = await methods.ingest({
      peer_id: 'urn:minder:peer:leon',
      messages: [{ content: 'hello' }, { content: 'world' }],
    });
    assert.equal(res.messages_ingested, 2);
    assert.ok(res.total_tokens > 0);
    assert.equal(typeof res.session_id, 'string');
  });

  it('search rejects missing query', async () => {
    const methods = createToolMethods(makeDeps());
    await assert.rejects(() => methods.search({}), (err) => err.code === 'EBADPARAM');
  });

  it('search surfaces EMBEDDING_UNAVAILABLE when vectr returns null', async () => {
    const methods = createToolMethods(makeDeps({ vectr: createMockVectr(null) }));
    await assert.rejects(
      () => methods.search({ query: 'x' }),
      (err) => err.code === 'EMBEDDING_UNAVAILABLE'
    );
  });

  it('getCard throws PEER_NOT_FOUND for unknown peer', async () => {
    const methods = createToolMethods(makeDeps({
      pool: createMockPool({ 'SELECT id, name, peer_type, status, card, created_at': { rows: [] } }),
    }));
    await assert.rejects(
      () => methods.getCard({ peer_id: 'urn:minder:peer:nobody' }),
      (err) => err.code === 'PEER_NOT_FOUND'
    );
  });

  it('getCard returns card entries', async () => {
    const methods = createToolMethods(makeDeps());
    const res = await methods.getCard({ peer_id: 'urn:minder:peer:leon' });
    assert.equal(res.name, 'Leon');
    assert.equal(res.card_entries, 1);
  });

  it('stats returns aggregate counts', async () => {
    const methods = createToolMethods(makeDeps());
    const res = await methods.stats();
    assert.equal(res.active_peers, 1);
    assert.equal(res.total_peers, 2);
  });

  it('config read returns value when key exists', async () => {
    const methods = createToolMethods(makeDeps());
    const res = await methods.config({ key: 'someKey' });
    assert.deepEqual(res.value, { foo: 'bar' });
  });

  it('config read throws CONFIG_KEY_NOT_FOUND when key missing', async () => {
    const methods = createToolMethods(makeDeps({
      pool: createMockPool({ 'SELECT value, updated_at FROM config': { rows: [] } }),
    }));
    await assert.rejects(
      () => methods.config({ key: 'missing' }),
      (err) => err.code === 'CONFIG_KEY_NOT_FOUND'
    );
  });

  it('config write persists and returns status=updated', async () => {
    const methods = createToolMethods(makeDeps());
    const res = await methods.config({ key: 'k', value: 42 });
    assert.equal(res.status, 'updated');
    assert.equal(res.value, 42);
  });
});

describe('Minder tool-methods — LLM methods (with agents available)', () => {
  it('query returns answer from dialecticWorker', async () => {
    const methods = createToolMethods(makeDeps());
    const res = await methods.query({
      peer_id: 'urn:minder:peer:leon',
      question: 'what is this person like?',
    });
    assert.equal(typeof res.answer, 'string');
    assert.equal(res.peer, 'Leon');
  });

  it('dream calls triggerDream', async () => {
    let capturedPeerId = 'not-called';
    const methods = createToolMethods(makeDeps({
      triggerDream: async (peerId) => {
        capturedPeerId = peerId;
        return { status: 'complete', cycle_number: 5 };
      },
    }));
    const res = await methods.dream({ peer_id: 'urn:minder:peer:leon' });
    assert.equal(capturedPeerId, 'urn:minder:peer:leon');
    assert.equal(res.cycle_number, 5);
  });

  it('dream throws DREAM_UNAVAILABLE when triggerDream not wired', async () => {
    const methods = createToolMethods(makeDeps({ triggerDream: undefined }));
    await assert.rejects(
      () => methods.dream({}),
      (err) => err.code === 'DREAM_UNAVAILABLE'
    );
  });

  it('dreamAnalysis returns analysis content', async () => {
    const methods = createToolMethods(makeDeps());
    const res = await methods.dreamAnalysis({ peer_id: 'urn:minder:peer:leon' });
    assert.equal(typeof res.analysis, 'string');
    assert.equal(res.peer, 'Leon');
  });

  it('memoryPerception returns short-circuit response when card is empty', async () => {
    const methods = createToolMethods(makeDeps({
      pool: createMockPool({
        'SELECT name, card FROM peers': { rows: [{ name: 'Leon', card: { entries: [] } }] },
      }),
    }));
    const res = await methods.memoryPerception({ peer_id: 'urn:minder:peer:leon' });
    assert.equal(res.entry_count, 0);
    assert.match(res.analysis, /No card entries/);
  });
});
