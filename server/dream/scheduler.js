/**
 * Dream cycle scheduler for Minder.
 *
 * Runs 4 phases sequentially per peer:
 *   Phase 1: Deduction — logical conclusions from explicit facts
 *   Phase 2: Induction — patterns across all observation levels
 *   Phase 3: Contradiction — detect mutually exclusive observations
 *   Phase 4: Card generation — synthesize biographical summary
 *
 * Default DISABLED. Enable via DREAM_ENABLED=true.
 */

import { runDeduction } from './deduction.js';
import { runInduction } from './induction.js';
import { runContradiction } from './contradiction.js';
import { runCardGeneration } from './card-generation.js';

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

/**
 * Run the full dream cycle.
 *
 * @param {object} pool - pg Pool
 * @param {object} agents - LLM agent clients
 * @param {object} vectr - Vectr client
 * @param {string|null} peerId - optional: scope to one peer
 * @param {boolean} force - override any cooldown
 * @returns {Promise<object>}
 */
export async function runDreamCycle(pool, agents, vectr, peerId = null, force = false) {
  log('dream_cycle_start', { peer_id: peerId || 'all' });
  const startTime = Date.now();

  // Get cycle number
  const configResult = await pool.query("SELECT value FROM config WHERE key = 'dream_cycle'").catch(() => ({ rows: [] }));
  let cycleNumber = configResult.rows.length > 0 ? (configResult.rows[0].value || 0) : 0;
  cycleNumber++;

  // Get peers to dream about
  let peers;
  if (peerId) {
    peers = await pool.query("SELECT id, name FROM peers WHERE id = $1 AND status = 'active'", [peerId]);
  } else {
    peers = await pool.query("SELECT id, name FROM peers WHERE status = 'active'");
  }

  const totals = {
    deductions_created: 0,
    inductions_created: 0,
    contradictions_found: 0,
    cards_updated: 0,
  };

  const peersDreamed = [];

  for (const peer of peers.rows) {
    const peerResult = {
      peer_id: peer.id,
      name: peer.name,
      phases: {},
    };

    try {
      // Phase 1: Deduction
      const deductions = await runDeduction(pool, agents.deductionWorker, vectr, peer.id);
      peerResult.phases.deduction = deductions;
      totals.deductions_created += deductions.created;

      // Phase 2: Induction
      const inductions = await runInduction(pool, agents.inductionWorker, vectr, peer.id);
      peerResult.phases.induction = inductions;
      totals.inductions_created += inductions.created;

      // Phase 3: Contradiction
      const contradictions = await runContradiction(pool, agents.dialecticWorker, peer.id);
      peerResult.phases.contradiction = contradictions;
      totals.contradictions_found += contradictions.found;

      // Phase 4: Card generation
      const card = await runCardGeneration(pool, agents.cardGenerator, peer.id);
      peerResult.phases.card = card;
      if (card.updated) totals.cards_updated++;

    } catch (err) {
      log('dream_peer_error', { peer_id: peer.id, error: err.message });
      peerResult.error = err.message;
    }

    peersDreamed.push(peerResult);
  }

  // Update cycle number in config
  await pool.query(`
    INSERT INTO config (key, value, updated_at) VALUES ('dream_cycle', $1, NOW())
    ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()
  `, [JSON.stringify(cycleNumber)]).catch(() => {});

  const result = {
    cycle_number: cycleNumber,
    timestamp: new Date().toISOString(),
    status: 'complete',
    duration_ms: Date.now() - startTime,
    peers_dreamed: peersDreamed,
    totals,
  };

  log('dream_cycle_complete', {
    cycle_number: cycleNumber,
    duration_ms: result.duration_ms,
    ...totals,
  });

  return result;
}
