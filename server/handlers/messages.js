/**
 * Spine directed message dispatcher for Minder.
 *
 * Routes incoming OTM messages by payload.event_type.
 */

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function createMessageHandler(pool, agents, vectr, triggerDream) {
  return async function handleMessage(envelope) {
    const { payload, message_id } = envelope;
    const eventType = payload?.event_type;

    log('minder_message_received', { event_type: eventType, message_id });

    switch (eventType) {
      case 'ingest':
        return await handleIngest(pool, payload);

      case 'identify':
        return await handleIdentify(pool, payload);

      case 'dream_trigger':
        return await handleDreamTrigger(triggerDream, payload);

      case 'card':
        return await handleCard(pool, payload);

      case 'query':
        return await handleQuery(pool, agents, payload);

      case 'search':
        return await handleSearch(pool, vectr, payload);

      case 'stats':
        return await handleStats(pool);

      case 'derive':
        return { event_type: 'derive_response', status: 'use_http', message: 'POST /derive for manual trigger' };

      default:
        log('minder_unknown_event_type', { event_type: eventType, message_id });
        return { error: 'unknown_event_type', event_type: eventType };
    }
  };
}

async function handleIngest(pool, payload) {
  const { peer_id, session_id, messages = [] } = payload;
  if (!peer_id || messages.length === 0) return { error: 'peer_id and messages required' };

  const sessId = session_id || `urn:minder:session:${Date.now()}`;
  await pool.query('INSERT INTO sessions (id) VALUES ($1) ON CONFLICT DO NOTHING', [sessId]);
  await pool.query('INSERT INTO session_peers (session_id, peer_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [sessId, peer_id]);

  let totalTokens = 0;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const tokenCount = Math.ceil((msg.content?.length || 0) / 4);
    totalTokens += tokenCount;
    await pool.query(
      'INSERT INTO messages (session_id, peer_id, content, metadata, token_count, seq) VALUES ($1, $2, $3, $4, $5, $6)',
      [sessId, peer_id, msg.content, JSON.stringify(msg.metadata || {}), tokenCount, i + 1],
    );
  }

  return { event_type: 'ingest_response', session_id: sessId, messages_ingested: messages.length, total_tokens: totalTokens };
}

async function handleIdentify(pool, payload) {
  const { name } = payload;
  if (!name) return { error: 'name required' };

  const peerId = `urn:minder:peer:${slugify(name)}`;
  const peer = await pool.query('SELECT id, name, peer_type, status, card, created_at FROM peers WHERE id = $1', [peerId]);

  if (peer.rows.length === 0) return { event_type: 'identify_response', status: 'unknown', peer_id: peerId };

  const p = peer.rows[0];
  if (p.status === 'retired') return { event_type: 'identify_response', status: 'retired', peer_id: peerId };

  const card = p.card || {};
  return {
    event_type: 'identify_response',
    status: 'identified',
    peer_id: peerId,
    name: p.name,
    card_summary: {
      total_entries: (card.entries || []).length,
      dream_cycle: card.dream_cycle || 0,
    },
  };
}

async function handleDreamTrigger(triggerDream, payload) {
  if (!triggerDream) return { event_type: 'dream_response', status: 'dream_disabled' };
  const result = await triggerDream(payload.peer_id);
  return { event_type: 'dream_response', ...result };
}

async function handleCard(pool, payload) {
  const { peer_id } = payload;
  if (!peer_id) return { error: 'peer_id required' };

  const peer = await pool.query('SELECT name, card FROM peers WHERE id = $1', [peer_id]);
  if (peer.rows.length === 0) return { error: 'PEER_NOT_FOUND' };

  const card = peer.rows[0].card || {};
  return {
    event_type: 'card_response',
    peer_id,
    name: peer.rows[0].name,
    card: card.entries || [],
    card_entries: (card.entries || []).length,
  };
}

async function handleQuery(pool, agents, payload) {
  const { peer_id, question } = payload;
  if (!peer_id || !question) return { error: 'peer_id and question required' };
  if (!agents.isAvailable()) return { error: 'LLM unavailable' };

  const peer = await pool.query('SELECT name, card FROM peers WHERE id = $1', [peer_id]);
  if (peer.rows.length === 0) return { error: 'PEER_NOT_FOUND' };

  const card = peer.rows[0].card || {};
  const entries = card.entries || [];
  const cardText = entries.map(e => `[${e.type}] ${e.content}`).join('\n');

  const response = await agents.dialecticWorker.chat(
    [{ role: 'user', content: `Question: ${question}\n\nCard:\n${cardText}` }],
    { system: 'Answer concisely about this person using the card data.', thinking: true, thinkingBudget: 3000 },
  );

  return { event_type: 'query_response', answer: response.content, peer: peer.rows[0].name };
}

async function handleSearch(pool, vectr, payload) {
  const { query, peer_id, level, limit = 10 } = payload;
  if (!query) return { error: 'query required' };

  const embedding = await vectr.embed(query);
  if (!embedding) return { error: 'EMBEDDING_UNAVAILABLE' };

  let sql = `
    SELECT o.id, o.content, o.level, o.confidence, 1 - (o.embedding <=> $1::vector) AS similarity
    FROM observations o JOIN collections c ON o.collection_id = c.id
    WHERE o.embedding IS NOT NULL AND o.deleted_at IS NULL AND (o.embedding <=> $1::vector) < 0.3
  `;
  const params = [JSON.stringify(embedding)];
  let idx = 2;
  if (peer_id) { sql += ` AND c.observed_id = $${idx}`; params.push(peer_id); idx++; }
  if (level) { sql += ` AND o.level = $${idx}`; params.push(level); idx++; }
  sql += ` ORDER BY similarity DESC LIMIT $${idx}`;
  params.push(parseInt(limit));

  const result = await pool.query(sql, params);
  return { event_type: 'search_response', count: result.rows.length, results: result.rows };
}

async function handleStats(pool) {
  const result = await pool.query(`
    SELECT COUNT(*) FILTER (WHERE status = 'active') AS active, COUNT(*) AS total FROM peers
  `);
  const obsCount = await pool.query('SELECT COUNT(*) AS count FROM observations WHERE deleted_at IS NULL');
  return {
    event_type: 'stats_response',
    active_peers: parseInt(result.rows[0].active),
    total_peers: parseInt(result.rows[0].total),
    total_observations: parseInt(obsCount.rows[0].count),
  };
}
