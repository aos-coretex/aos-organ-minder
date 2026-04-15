/**
 * Minder tool_call_request handler — MP-TOOL-1 relay t8r-4.
 *
 * Tests handler wiring: dispatch, fail-fast on missing method, TOOL_NOT_FOUND,
 * TOOL_ERROR (with llm_unavailable surfacing), TOOL_TIMEOUT, ORGAN_DEGRADED,
 * schema validation, live-file integration.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createToolHandler } from '../server/tool-handler.js';
import { createMockPool, createMockAgents, createMockVectr, fakeEmbedding } from './helpers.js';

const DECLARATIONS_FIXTURE = {
  organs: {
    minder: {
      organ_number: 70,
      organ_port: 4007,
      timeout_ms: 45000,
      tools: {
        identify:          { method: 'identify' },
        register_peer:     { method: 'registerPeer' },
        retire_peer:       { method: 'retirePeer' },
        ingest:            { method: 'ingest' },
        query:             { method: 'query',           timeout_ms: 43000 },
        search:            { method: 'search',          timeout_ms: 43000 },
        get_card:          { method: 'getCard' },
        get_representation:{ method: 'getRepresentation' },
        stats:             { method: 'stats' },
        config:            { method: 'config' },
        derive:            { method: 'derive' },
        dream:             { method: 'dream',           timeout_ms: 43000 },
        dream_analysis:    { method: 'dreamAnalysis',   timeout_ms: 43000 },
        memory_perception: { method: 'memoryPerception', timeout_ms: 43000 },
      },
    },
  },
};

function envelope(tool, params = {}) {
  return {
    message_id: `test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    target_organ: 'Minder',
    reply_to: 'mcp-router',
    payload: { event_type: 'tool_call_request', tool, params },
  };
}

function makeDeps(overrides = {}) {
  return {
    pool: overrides.pool ?? createMockPool({
      'SELECT id, name, peer_type, status, card, metadata': {
        rows: [{
          id: 'urn:minder:peer:leon',
          name: 'Leon',
          peer_type: 'human',
          status: 'active',
          card: { entries: [], dream_cycle: 0 },
          metadata: {},
          created_at: '2026-04-01T00:00:00Z',
        }],
      },
      'INSERT INTO sessions': { rows: [] },
      'INSERT INTO session_peers': { rows: [] },
      'JOIN sessions s ON s.id': { rows: [] },
    }),
    vectr: overrides.vectr ?? createMockVectr(fakeEmbedding()),
    agents: overrides.agents ?? createMockAgents(true),
    triggerDream: overrides.triggerDream ?? (async () => ({ status: 'complete', cycle_number: 1 })),
    deriveTokenThreshold: 1000,
  };
}

describe('Minder tool-handler — D4 dispatch', () => {
  it('constructs with fixture (all 14 methods resolve)', () => {
    const h = createToolHandler(makeDeps(), { declarations: DECLARATIONS_FIXTURE });
    assert.equal(typeof h, 'function');
  });

  it('fails fast on missing method (D5)', () => {
    const broken = {
      organs: { minder: { tools: { identify: { method: 'doesNotExist' } } } },
    };
    assert.throws(
      () => createToolHandler(makeDeps(), { declarations: broken }),
      /doesNotExist/
    );
  });

  it('dispatches minder__identify → SUCCESS (this is the live-evidence timeout bug closed)', async () => {
    const handler = createToolHandler(makeDeps(), { declarations: DECLARATIONS_FIXTURE });
    const res = await handler(envelope('minder__identify', { name: 'Leon' }));
    assert.equal(res.event_type, 'tool_call_response');
    assert.equal(res.status, 'SUCCESS');
    assert.equal(res.tool, 'minder__identify');
    assert.equal(res.data.status, 'identified');
    assert.equal(res.data.peer_id, 'urn:minder:peer:leon');
  });

  it('dispatches minder__stats → SUCCESS (non-LLM, deterministic)', async () => {
    const deps = makeDeps({
      pool: createMockPool({
        'FILTER (WHERE status': { rows: [{ active: '1', total: '1' }] },
        'FROM observations WHERE deleted_at': { rows: [{ count: '0' }] },
      }),
    });
    const handler = createToolHandler(deps, { declarations: DECLARATIONS_FIXTURE });
    const res = await handler(envelope('minder__stats'));
    assert.equal(res.status, 'SUCCESS');
    assert.equal(res.data.active_peers, 1);
  });

  it('unknown tool → TOOL_NOT_FOUND', async () => {
    const handler = createToolHandler(makeDeps(), { declarations: DECLARATIONS_FIXTURE });
    const res = await handler(envelope('minder__bogus'));
    assert.equal(res.status, 'TOOL_NOT_FOUND');
  });

  it('LLM method → TOOL_ERROR with llm_unavailable when agents down (#20)', async () => {
    const handler = createToolHandler(
      makeDeps({ agents: createMockAgents(false) }),
      { declarations: DECLARATIONS_FIXTURE }
    );
    const res = await handler(envelope('minder__query', {
      peer_id: 'urn:minder:peer:leon',
      question: 'x',
    }));
    assert.equal(res.status, 'TOOL_ERROR');
    assert.equal(res.error.code, 'llm_unavailable');
  });

  it('method validation failure → TOOL_ERROR with EBADPARAM', async () => {
    const handler = createToolHandler(makeDeps(), { declarations: DECLARATIONS_FIXTURE });
    const res = await handler(envelope('minder__identify', {}));
    assert.equal(res.status, 'TOOL_ERROR');
    assert.equal(res.error.code, 'EBADPARAM');
  });

  it('ORGAN_DEGRADED when healthCheck reports db down', async () => {
    const handler = createToolHandler(makeDeps(), {
      declarations: DECLARATIONS_FIXTURE,
      healthCheck: async () => ({ db: 'down' }),
    });
    const res = await handler(envelope('minder__stats'));
    assert.equal(res.status, 'ORGAN_DEGRADED');
    assert.equal(res.checks_status, 'down');
  });

  it('ORGAN_DEGRADED when healthCheck throws (fail-closed)', async () => {
    const handler = createToolHandler(makeDeps(), {
      declarations: DECLARATIONS_FIXTURE,
      healthCheck: async () => { throw new Error('boom'); },
    });
    const res = await handler(envelope('minder__stats'));
    assert.equal(res.status, 'ORGAN_DEGRADED');
    assert.equal(res.checks_status, 'down');
  });

  it('TOOL_TIMEOUT when method exceeds declared timeout_ms', async () => {
    // Slow pool simulating a 100ms query under a 20ms tool timeout.
    const slowPool = createMockPool({});
    slowPool.query = () => new Promise(r => setTimeout(() => r({
      rows: [{ active: '0', total: '0' }],
    }), 100));

    const tightDecl = {
      organs: { minder: { tools: { stats: { method: 'stats', timeout_ms: 20 } } } },
    };
    const handler = createToolHandler(
      { pool: slowPool, vectr: createMockVectr(), agents: createMockAgents(true) },
      { declarations: tightDecl }
    );
    const res = await handler(envelope('minder__stats'));
    assert.equal(res.status, 'TOOL_TIMEOUT');
    assert.equal(res.limit_ms, 20);
  });

  it('payload response passes tool-response-schema validation', async () => {
    const { validateToolResponse } = await import('@coretex/organ-boot/tool-response-schema');
    const handler = createToolHandler(makeDeps(), { declarations: DECLARATIONS_FIXTURE });
    const res = await handler(envelope('minder__identify', { name: 'Leon' }));
    assert.equal(validateToolResponse(res), true);
  });
});

describe('Minder tool-handler — live file integration', () => {
  it('resolves all 14 Minder tools against the live tool-declarations.json', () => {
    const handler = createToolHandler(makeDeps());
    assert.equal(typeof handler, 'function');
  });
});
