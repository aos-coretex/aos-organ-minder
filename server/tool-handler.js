/**
 * Minder organ tool_call_request handler — MP-TOOL-1 relay t8r-4.
 *
 * Same shape as Graph's (t8r-2) and Radiant's (t8r-3) tool-handlers: only
 * `ORGAN_NAME` and the method factory import change.
 *
 * D5 fail-fast at construction. Per-tool timeout via Promise.race. Typed
 * errors propagate as TOOL_ERROR with `error.code` and optional `meta`.
 */

import { readFileSync } from 'node:fs';
import {
  success,
  toolNotFound,
  toolError,
  toolTimeout,
  organDegraded,
} from '@coretex/organ-boot/tool-errors';
import { createToolMethods } from './tool-methods.js';

const DEFAULT_DECLARATIONS_PATH = '/Library/AI/AI-AOS/AOS-organ-dev/AOS-organ-mcp-router/AOS-organ-mcp-router-src/config/tool-declarations.json';
const DEFAULT_TIMEOUT_MS = 25000;
const ORGAN_NAME = 'minder';

function deriveHealthStatus(checks) {
  if (!checks || typeof checks !== 'object') return 'ok';
  const values = Object.values(checks);
  if (values.some(v => v === 'down' || v === 'error')) return 'down';
  if (values.some(v => v === 'degraded' || v === 'warning')) return 'degraded';
  return 'ok';
}

/**
 * @param {object} deps        — { pool, vectr, agents, triggerDream, deriveTokenThreshold }
 * @param {object} [options]
 * @param {function} [options.healthCheck]
 * @param {string}   [options.declarationsPath]
 * @param {object}   [options.declarations]
 * @returns {function(object): Promise<object>}
 */
export function createToolHandler(deps, options = {}) {
  const {
    healthCheck,
    declarationsPath = DEFAULT_DECLARATIONS_PATH,
    declarations: providedDeclarations,
  } = options;

  const declarations = providedDeclarations
    ?? JSON.parse(readFileSync(declarationsPath, 'utf-8'));

  const organEntry = declarations.organs?.[ORGAN_NAME];
  if (!organEntry) {
    throw new Error(`tool-declarations.json has no entry for organ "${ORGAN_NAME}"`);
  }

  const methods = createToolMethods(deps);

  const map = new Map();
  for (const [action, decl] of Object.entries(organEntry.tools)) {
    const toolName = `${ORGAN_NAME}__${action}`;
    const method = methods[decl.method];
    if (typeof method !== 'function') {
      throw new Error(
        `${toolName}: declared method '${decl.method}' is not implemented on Minder tool-methods`
      );
    }
    map.set(toolName, {
      method,
      timeout_ms: decl.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    });
  }

  return async function handleToolCallRequest(envelope) {
    const tool = envelope?.payload?.tool;
    const params = envelope?.payload?.params ?? {};

    if (typeof healthCheck === 'function') {
      let status = 'ok';
      try {
        const checks = await healthCheck();
        status = deriveHealthStatus(checks);
      } catch {
        status = 'down';
      }
      if (status !== 'ok') {
        return organDegraded(tool ?? 'unknown', status);
      }
    }

    const entry = typeof tool === 'string' ? map.get(tool) : undefined;
    if (!entry) {
      return toolNotFound(tool ?? 'unknown', ORGAN_NAME);
    }

    const start = Date.now();
    let timer;
    try {
      const data = await Promise.race([
        Promise.resolve().then(() => entry.method(params)),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => {
            const err = new Error(`tool ${tool} exceeded ${entry.timeout_ms}ms`);
            err._timeout = true;
            reject(err);
          }, entry.timeout_ms);
          if (typeof timer.unref === 'function') timer.unref();
        }),
      ]);
      return success(tool, data);
    } catch (err) {
      const elapsed = Date.now() - start;
      if (err && err._timeout) {
        return toolTimeout(tool, elapsed, entry.timeout_ms);
      }
      const code = (err && err.code) || 'internal_error';
      const message = (err && err.message) || String(err);
      return toolError(tool, code, message);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
