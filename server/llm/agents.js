/**
 * Minder internal service agents.
 *
 * 5 per-agent LLM clients, each with its own model configuration:
 *   - Deriver (Haiku) — extract explicit observations from messages
 *   - Deduction worker (Haiku) — logical inference from explicit facts
 *   - Induction worker (Sonnet) — pattern generalization across all levels
 *   - Dialectic worker (Haiku + thinking) — NL query answering
 *   - Card generator (Sonnet) — biographical summary synthesis
 */

import { createLLMClient } from '@coretex/organ-boot/llm-client';

export function createAgents() {
  const deriver = createLLMClient({
    agentName: 'deriver',
    defaultModel: 'claude-haiku-4-5-20251001',
    defaultProvider: 'anthropic',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    maxTokens: 1024,
  });

  const deductionWorker = createLLMClient({
    agentName: 'deduction_worker',
    defaultModel: 'claude-haiku-4-5-20251001',
    defaultProvider: 'anthropic',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    maxTokens: 1024,
  });

  const inductionWorker = createLLMClient({
    agentName: 'induction_worker',
    defaultModel: 'claude-sonnet-4-6',
    defaultProvider: 'anthropic',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    maxTokens: 2048,
  });

  const dialecticWorker = createLLMClient({
    agentName: 'dialectic_worker',
    defaultModel: 'claude-haiku-4-5-20251001',
    defaultProvider: 'anthropic',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    maxTokens: 1024,
    thinking: true,
    thinkingBudget: 5000,
  });

  const cardGenerator = createLLMClient({
    agentName: 'card_generator',
    defaultModel: 'claude-sonnet-4-6',
    defaultProvider: 'anthropic',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    maxTokens: 4096,
  });

  function isAvailable() {
    return deriver.isAvailable(); // all share the same API key
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
  };
}
