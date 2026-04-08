/**
 * Test helpers — mock pg Pool, mock agents, mock Vectr.
 */

export function createMockPool(queryMap = {}) {
  const queries = [];
  let defaultResult = { rows: [] };

  function findResult(sql) {
    for (const [pattern, result] of Object.entries(queryMap)) {
      if (sql.includes(pattern)) return result;
    }
    return defaultResult;
  }

  const pool = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      return findResult(sql);
    },
    connect: async () => {
      let released = false;
      return {
        query: async (sql, params) => {
          queries.push({ sql, params });
          return findResult(sql);
        },
        release: () => { released = true; },
      };
    },
    end: async () => {},
    getQueries: () => queries,
    setDefault: (result) => { defaultResult = result; },
  };

  return pool;
}

export function createMockVectr(embedding = null) {
  return {
    embed: async () => embedding,
    isAvailable: async () => embedding !== null,
  };
}

export function createMockAgents(available = false) {
  const mockChat = async (messages, options) => ({
    content: '{"observations": [], "deductions": [], "inductions": [], "contradictions": [], "entries": []}',
    model: 'mock-model',
    input_tokens: 10,
    output_tokens: 5,
  });

  const agent = {
    chat: mockChat,
    isAvailable: () => available,
    getUsage: () => ({ agent: 'mock', total_input: 0, total_output: 0, total_calls: 0, errors: 0 }),
  };

  return {
    deriver: agent,
    deductionWorker: agent,
    inductionWorker: agent,
    dialecticWorker: agent,
    cardGenerator: agent,
    isAvailable: () => available,
    getUsage: () => ({
      deriver: agent.getUsage(),
      deduction_worker: agent.getUsage(),
      induction_worker: agent.getUsage(),
      dialectic_worker: agent.getUsage(),
      card_generator: agent.getUsage(),
    }),
  };
}

export function fakeEmbedding() {
  return Array.from({ length: 384 }, (_, i) => Math.sin(i * 0.1));
}
