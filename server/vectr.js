/**
 * Vectr HTTP client for embedding generation.
 *
 * Graceful degradation: if Vectr is unreachable (5s timeout),
 * returns null. Caller stores without embedding.
 */

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

export function createVectrClient(vectrUrl, timeoutMs = 5000) {
  async function embed(text) {
    const truncated = text.slice(0, 8192);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(`${vectrUrl}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: truncated }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) { log('vectr_error', { status: res.status }); return null; }
      const data = await res.json();
      const embedding = data.embedding || data.vector;
      if (!embedding || !Array.isArray(embedding) || embedding.length !== 384) {
        log('vectr_invalid_response', { length: embedding?.length });
        return null;
      }
      return embedding;
    } catch (err) {
      log('vectr_unavailable', { error: err.name === 'AbortError' ? 'timeout' : err.message });
      return null;
    }
  }

  async function isAvailable() {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`${vectrUrl}/health`, { signal: controller.signal });
      clearTimeout(timer);
      return res.ok;
    } catch { return false; }
  }

  return { embed, isAvailable };
}
