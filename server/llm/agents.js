/**
 * Minder internal service agents.
 *
 * 5 per-agent LLM clients resolved from `01-Organs/70-Minder/` YAML settings via
 * `@coretex/organ-boot/llm-settings-loader`:
 *   - Deriver                — extract explicit observations from messages
 *   - Deduction worker       — logical inference from explicit facts
 *   - Induction worker       — pattern generalization across all levels
 *   - Dialectic worker       — NL query answering (extended thinking per D9)
 *   - Card generator         — biographical summary synthesis
 *
 * Per MP-CONFIG-1 R6 (l9m-6), each agent's model, provider, max_tokens, and
 * `thinking` block are settings-driven; source holds no hardcoded model strings.
 *
 * Dialectic-worker thinking pass-through (D9):
 *   minder-organ-dialectic-worker-llm-settings.yaml defines
 *   `thinking: { enabled: true, budget_tokens: 5000 }`; the loader transforms
 *   this into `{ thinking: true, thinkingBudget: 5000 }` on the resolved config,
 *   which the cascade-wrapped chat hands to the provider via `llm.chat(messages,
 *   { thinking: true, thinkingBudget: 5000, ... })`.
 */

import { createLoader } from '@coretex/organ-boot/llm-settings-loader';

/**
 * Build the 5 Minder service agents backed by the settings loader.
 *
 * @param {object} opts
 * @param {string} opts.settingsRoot — absolute path to `01-Organs/`
 * @returns {{
 *   deriver, deductionWorker, inductionWorker, dialecticWorker, cardGenerator,
 *   isAvailable, getUsage, introspect
 * }}
 */
export function createAgents({ settingsRoot } = {}) {
  const loader = createLoader({
    organNumber: 70,
    organName: 'minder',
    settingsRoot,
  });

  function buildClient(agentName) {
    const { config: resolved, chat } = loader.resolveWithCascade(agentName);
    const apiKeyEnv = resolved.apiKeyEnvVar || 'ANTHROPIC_API_KEY';
    return {
      chat,
      isAvailable: () => Boolean(process.env[apiKeyEnv]),
      getUsage: () => ({ agent: resolved.agentName, model: resolved.defaultModel, provider: resolved.defaultProvider }),
    };
  }

  const deriver = buildClient('deriver');
  const deductionWorker = buildClient('deduction-worker');
  const inductionWorker = buildClient('induction-worker');
  const dialecticWorker = buildClient('dialectic-worker');
  const cardGenerator = buildClient('card-generator');

  function isAvailable() {
    return deriver.isAvailable(); // all five share ANTHROPIC_API_KEY
  }

  function getUsage() {
    return {
      deriver: deriver.getUsage(),
      deduction_worker: deductionWorker.getUsage(),
      induction_worker: inductionWorker.getUsage(),
      dialectic_worker: dialecticWorker.getUsage(),
      card_generator: cardGenerator.getUsage(),
    };
  }

  return {
    deriver,
    deductionWorker,
    inductionWorker,
    dialecticWorker,
    cardGenerator,
    isAvailable,
    getUsage,
    introspect: () => loader.introspect(),
  };
}
