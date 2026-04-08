/**
 * Dream Phase 4 — Card Generation.
 *
 * Synthesize a max-40-entry biographical summary from all
 * non-deleted, non-contradiction observations for a peer.
 */

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

export async function runCardGeneration(pool, cardGenerator, peerId) {
  log('dream_card_generation_start', { peer_id: peerId });

  const result = { updated: false, entries: 0, error: null };

  // Load all non-deleted, non-contradiction observations
  const obs = await pool.query(`
    SELECT o.content, o.level, o.confidence, o.metadata, o.times_derived
    FROM observations o
    JOIN collections c ON o.collection_id = c.id
    WHERE c.observed_id = $1
      AND o.level != 'contradiction'
      AND o.deleted_at IS NULL
    ORDER BY
      CASE o.level WHEN 'explicit' THEN 1 WHEN 'deductive' THEN 2 WHEN 'inductive' THEN 3 ELSE 4 END,
      o.confidence DESC,
      o.times_derived DESC
    LIMIT 200
  `, [peerId]);

  if (obs.rows.length === 0) {
    log('dream_card_generation_skip', { peer_id: peerId, reason: 'no observations' });
    return result;
  }

  // Get peer name
  const peer = await pool.query('SELECT name FROM peers WHERE id = $1', [peerId]);
  const peerName = peer.rows[0]?.name || peerId;

  const obsText = obs.rows.map(o => {
    const category = o.metadata?.category || '';
    return `[${o.level}|${o.confidence}${category ? '|' + category : ''}] ${o.content}`;
  }).join('\n');

  try {
    const response = await cardGenerator.chat(
      [{ role: 'user', content: `Person: ${peerName}\n\nObservations:\n${obsText}` }],
      {
        system: `Generate a biographical person card with maximum 40 entries. Each entry has: type (FACT, TRAIT, PATTERN, PREFERENCE, INSTRUCTION, MOTIVATION, PREDICTION), content (concise statement), confidence (high, medium, low), source_count (number of supporting observations). Return JSON: { "entries": [{ "type": "FACT", "content": "...", "confidence": "high", "source_count": 3 }, ...] }. Prioritize high-confidence, well-supported entries. Be selective — quality over quantity.`,
        maxTokens: 4096,
      },
    );

    let entries = [];
    try {
      const parsed = JSON.parse(response.content);
      entries = parsed.entries || [];
    } catch {
      log('dream_card_parse_error', { peer_id: peerId });
      result.error = 'parse_error';
      return result;
    }

    // Enforce max 40 entries
    if (entries.length > 40) {
      entries = entries.slice(0, 40);
    }

    // Get current dream cycle
    const cycleResult = await pool.query("SELECT value FROM config WHERE key = 'dream_cycle'").catch(() => ({ rows: [] }));
    const dreamCycle = cycleResult.rows.length > 0 ? cycleResult.rows[0].value : 0;

    // Update peer card
    const cardData = {
      entries,
      last_updated: new Date().toISOString(),
      dream_cycle: dreamCycle,
      observation_count: obs.rows.length,
    };

    await pool.query('UPDATE peers SET card = $1 WHERE id = $2', [JSON.stringify(cardData), peerId]);

    result.updated = true;
    result.entries = entries.length;

    log('dream_card_generation_complete', {
      peer_id: peerId,
      entries: entries.length,
      dream_cycle: dreamCycle,
    });
  } catch (err) {
    log('dream_card_generation_error', { peer_id: peerId, error: err.message });
    result.error = err.message;
  }

  return result;
}
