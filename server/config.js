/**
 * Minder organ configuration.
 *
 * Ports: 3907 (SAAS) / 4007 (AOS)
 * Database: PostgreSQL `minder` on localhost:5432
 */

const vaultRoot = process.env.VAULT_ROOT
  || '/Library/AI/AI-Infra-MDvaults/MDvault-LLM-Ops';

export const config = {
  port: parseInt(process.env.MINDER_PORT || '4007', 10),
  binding: '127.0.0.1',
  spineUrl: process.env.SPINE_URL || 'http://127.0.0.1:4000',

  db: {
    host: process.env.MINDER_DB_HOST || 'localhost',
    port: parseInt(process.env.MINDER_DB_PORT || '5432', 10),
    database: process.env.MINDER_DB_NAME || 'minder',
    user: process.env.MINDER_DB_USER || 'graphheight_sys',
    max: 5,
  },

  vectrUrl: process.env.LLM_OPS_EMBEDDING_URL || 'http://127.0.0.1:4001',
  vectrTimeoutMs: 5000,

  dreamEnabled: process.env.DREAM_ENABLED === 'true',
  dreamIntervalMs: parseInt(process.env.DREAM_INTERVAL_MS || String(24 * 60 * 60 * 1000), 10),

  deriveTokenThreshold: parseInt(process.env.DERIVE_TOKEN_THRESHOLD || '1000', 10),
  cardMaxEntries: parseInt(process.env.CARD_MAX_ENTRIES || '40', 10),

  vaultRoot,
  settingsRoot: process.env.SETTINGS_ROOT || `${vaultRoot}/01-Organs`,
};
