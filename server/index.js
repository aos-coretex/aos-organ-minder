/**
 * Minder ESB organ — entry point.
 *
 * Person memory (Monad Leg 3) — observations, dream cycle, person cards.
 * Connects to existing PostgreSQL database `minder` and exposes
 * its API via HTTP + Spine WebSocket.
 */

import { createOrgan } from '@coretex/organ-boot';
import { initializeUsageAttribution } from '@coretex/organ-boot/usage-attribution';
import { config } from './config.js';
import { createPool, verifySchema, checkDb } from './db/pool.js';
import { createVectrClient } from './vectr.js';
import { createAgents } from './llm/agents.js';
import { createPeersRouter } from './routes/peers.js';
import { createIngestRouter } from './routes/ingest.js';
import { createUnderstandingRouter } from './routes/understanding.js';
import { createDreamRouter } from './routes/dream.js';
import { createIdentityRouter } from './routes/identity.js';
import { createConfigRouter } from './routes/minder-config.js';
import { createStatsRouter } from './routes/stats.js';
import { createSnapshotRouter } from './routes/snapshot.js';
import { createMessageHandler } from './handlers/messages.js';
import { createToolHandler } from './tool-handler.js';
import { runDreamCycle } from './dream/scheduler.js';

// --- State ---

const dreamState = {
  cycleNumber: 0,
  lastRun: null,
  enabled: config.dreamEnabled,
  timer: null,
};

function getDreamState() {
  return dreamState;
}

// --- Boot ---

const pool = createPool(config.db);
const vectr = createVectrClient(config.vectrUrl, config.vectrTimeoutMs);
const agents = createAgents({ settingsRoot: config.settingsRoot });

// MP-CONFIG-1 R9 — register the process-default usage writer.
initializeUsageAttribution({ organName: 'Minder' });

async function triggerDream(peerId = null, force = false) {
  if (!agents.isAvailable()) {
    return { status: 'llm_unavailable', message: 'LLM API key not set' };
  }

  const result = await runDreamCycle(pool, agents, vectr, peerId, force);
  dreamState.cycleNumber = result.cycle_number;
  dreamState.lastRun = result.timestamp;
  return result;
}

function startDreamTimer() {
  if (dreamState.timer) clearInterval(dreamState.timer);
  dreamState.timer = setInterval(
    () => triggerDream().catch(err => {
      const entry = { timestamp: new Date().toISOString(), event: 'dream_cycle_error', error: err.message };
      process.stdout.write(JSON.stringify(entry) + '\n');
    }),
    config.dreamIntervalMs,
  );
}

const organ = await createOrgan({
  name: 'Minder',
  port: config.port,
  binding: config.binding,
  spineUrl: config.spineUrl,

  routes: (app) => {
    app.use('/', createSnapshotRouter(pool));
    app.use('/peers', createPeersRouter(pool));
    app.use('/', createIngestRouter(pool, agents, vectr, config.deriveTokenThreshold));
    app.use('/', createUnderstandingRouter(pool, agents, vectr));
    app.use('/', createDreamRouter(pool, agents, triggerDream));
    app.use('/', createIdentityRouter(pool));
    app.use('/', createConfigRouter(pool));
    app.use('/', createStatsRouter(pool, getDreamState));
  },

  onMessage: createMessageHandler(pool, agents, vectr, triggerDream),

  // MP-TOOL-1 R4: tool-call health gate scopes to DB only. Vectr + LLM
  // degradation surface per-tool (EMBEDDING_UNAVAILABLE / llm_unavailable)
  // rather than failing all 14 tools closed. Matches the R3 pattern.
  toolCallHandler: createToolHandler(
    { pool, vectr, agents, triggerDream, deriveTokenThreshold: config.deriveTokenThreshold },
    {
      healthCheck: async () => ({
        db: await checkDb(pool),
      }),
    }
  ),

  subscriptions: [
    { event_type: 'dream_trigger' },
  ],

  dependencies: ['Spine'],

  healthCheck: async () => ({
    db: await checkDb(pool),
    vectr: await vectr.isAvailable() ? 'ok' : 'degraded',
    dream: config.dreamEnabled ? 'enabled' : 'disabled',
    llm: agents.isAvailable() ? 'available' : 'unavailable',
  }),

  introspectCheck: async () => ({
    dream_state: getDreamState(),
    llm_usage: agents.getUsage(),
    // MP-CONFIG-1 R6 — flat per bug #9; consumed by Axon aggregator R8.
    llm: agents.introspect(),
  }),

  onStartup: async () => {
    await verifySchema(pool);

    if (config.dreamEnabled && agents.isAvailable()) {
      startDreamTimer();
    }
  },

  onShutdown: async () => {
    if (dreamState.timer) clearInterval(dreamState.timer);
    await pool.end();
  },
});
