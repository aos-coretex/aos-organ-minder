import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runDreamCycle } from '../server/dream/scheduler.js';
import { createMockPool, createMockAgents, createMockVectr } from './helpers.js';

describe('Dream cycle', () => {
  it('runs all 4 phases sequentially for each peer', async () => {
    const phasesExecuted = [];

    const pool = createMockPool({
      'SELECT value FROM config': { rows: [{ value: 5 }] },
      "SELECT id, name FROM peers WHERE status = 'active'": {
        rows: [{ id: 'urn:minder:peer:leon', name: 'Leon' }],
      },
      'SELECT id FROM collections': {
        rows: [{ id: 'urn:minder:collection:agent-leon' }],
      },
    });

    // Override query to track phases and return empty results
    const originalQuery = pool.query;
    pool.query = async (sql, params) => {
      if (sql.includes("level = 'explicit'")) phasesExecuted.push('deduction-load');
      if (sql.includes("level != 'contradiction'")) phasesExecuted.push('contradiction-load');
      if (sql.includes('UPDATE peers SET card')) phasesExecuted.push('card-update');
      return originalQuery(sql, params);
    };

    // Create agents that return valid JSON
    const agents = createMockAgents(true);

    // Override agent chat to return proper JSON for each phase
    agents.deductionWorker.chat = async () => ({
      content: '{"deductions": []}',
      input_tokens: 10, output_tokens: 5,
    });
    agents.inductionWorker.chat = async () => ({
      content: '{"inductions": []}',
      input_tokens: 10, output_tokens: 5,
    });
    agents.dialecticWorker.chat = async () => ({
      content: '{"contradictions": []}',
      input_tokens: 10, output_tokens: 5,
    });
    agents.cardGenerator.chat = async () => ({
      content: '{"entries": [{"type": "FACT", "content": "Test", "confidence": "high", "source_count": 1}]}',
      input_tokens: 10, output_tokens: 5,
    });

    const result = await runDreamCycle(pool, agents, createMockVectr(null));

    assert.equal(result.status, 'complete');
    assert.equal(result.cycle_number, 6); // was 5, now 6
    assert.equal(result.peers_dreamed.length, 1);
    assert.equal(result.peers_dreamed[0].name, 'Leon');
    assert.ok(result.peers_dreamed[0].phases.deduction);
    assert.ok(result.peers_dreamed[0].phases.induction);
    assert.ok(result.peers_dreamed[0].phases.contradiction);
    assert.ok(result.peers_dreamed[0].phases.card);
  });

  it('scopes dream to a single peer when peer_id provided', async () => {
    const pool = createMockPool({
      'SELECT value FROM config': { rows: [{ value: 0 }] },
      "SELECT id, name FROM peers WHERE id": {
        rows: [{ id: 'urn:minder:peer:leon', name: 'Leon' }],
      },
      'SELECT id FROM collections': { rows: [] },
    });
    // Mock all queries
    pool.query = async (sql, params) => {
      if (sql.includes("SELECT id, name FROM peers WHERE id")) {
        return { rows: [{ id: 'urn:minder:peer:leon', name: 'Leon' }] };
      }
      return { rows: [] };
    };

    const agents = createMockAgents(true);
    agents.deductionWorker.chat = async () => ({ content: '{"deductions": []}', input_tokens: 5, output_tokens: 5 });
    agents.inductionWorker.chat = async () => ({ content: '{"inductions": []}', input_tokens: 5, output_tokens: 5 });
    agents.dialecticWorker.chat = async () => ({ content: '{"contradictions": []}', input_tokens: 5, output_tokens: 5 });
    agents.cardGenerator.chat = async () => ({ content: '{"entries": []}', input_tokens: 5, output_tokens: 5 });

    const result = await runDreamCycle(pool, agents, createMockVectr(null), 'urn:minder:peer:leon');

    assert.equal(result.status, 'complete');
    assert.equal(result.peers_dreamed.length, 1);
  });

  it('handles peer with no collections gracefully', async () => {
    const pool = createMockPool({
      'SELECT value FROM config': { rows: [{ value: 0 }] },
      "SELECT id, name FROM peers WHERE status = 'active'": {
        rows: [{ id: 'urn:minder:peer:new', name: 'New Person' }],
      },
      'SELECT id FROM collections': { rows: [] },
    });

    // Mock the card generation queries
    pool.query = async (sql) => {
      if (sql.includes("SELECT id, name FROM peers WHERE status")) {
        return { rows: [{ id: 'urn:minder:peer:new', name: 'New Person' }] };
      }
      return { rows: [] };
    };

    const agents = createMockAgents(true);
    agents.deductionWorker.chat = async () => ({ content: '{"deductions": []}', input_tokens: 5, output_tokens: 5 });
    agents.inductionWorker.chat = async () => ({ content: '{"inductions": []}', input_tokens: 5, output_tokens: 5 });
    agents.dialecticWorker.chat = async () => ({ content: '{"contradictions": []}', input_tokens: 5, output_tokens: 5 });
    agents.cardGenerator.chat = async () => ({ content: '{"entries": []}', input_tokens: 5, output_tokens: 5 });

    const result = await runDreamCycle(pool, agents, createMockVectr(null));

    assert.equal(result.status, 'complete');
    // Should complete without error even with no observations
    assert.ok(result.peers_dreamed[0].phases.card);
  });
});
