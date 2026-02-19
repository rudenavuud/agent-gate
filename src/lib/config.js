'use strict';

/**
 * Config loading and validation.
 *
 * Loads config from (in priority order):
 *   1. AGENT_GATE_CONFIG env var
 *   2. /etc/agent-gate/config.json
 *   3. ./config.json (cwd)
 *
 * All fields have sensible defaults. Validation produces
 * clear, actionable error messages.
 */

const fs = require('fs');
const path = require('path');

// macOS uses /var/run, Linux uses /run
const RUN_BASE = process.platform === 'darwin' ? '/var/run/agent-gate' : '/run/agent-gate';

const DEFAULTS = {
  socketPath: `${RUN_BASE}/agent-gate.sock`,
  httpPort: 18891,
  pidFile: `${RUN_BASE}/agent-gate.pid`,
  cacheTTL: 900000,
  approvalTimeoutMs: 300000, // 5 minutes
  pendingDir: `${RUN_BASE}/pending`,
  auditLogPath: `${RUN_BASE}/audit.log`,
  openVaults: [],
  gatedVaults: [],
  standingApprovals: [],
  providers: {
    default: 'onepassword',
    onepassword: {
      serviceAccountTokenPath: null
    }
  },
  channels: {}
};

const CONFIG_SEARCH_PATHS = [
  process.env.AGENT_GATE_CONFIG,
  '/etc/agent-gate/config.json',
  path.join(process.cwd(), 'config.json')
].filter(Boolean);

/**
 * Find and load config file. Returns { config, configPath }.
 * Throws with helpful message if no config found.
 */
function load(explicitPath) {
  const searchPaths = explicitPath ? [explicitPath] : CONFIG_SEARCH_PATHS;

  for (const p of searchPaths) {
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const parsed = JSON.parse(raw);
      const merged = merge(DEFAULTS, parsed);
      validate(merged);
      return { config: merged, configPath: p };
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      if (e instanceof SyntaxError) {
        throw new Error(`Config file ${p} is not valid JSON: ${e.message}`);
      }
      throw e;
    }
  }

  throw new Error(
    'No config file found. Searched:\n' +
    searchPaths.map(p => `  - ${p}`).join('\n') +
    '\n\nCreate one from config.example.json:\n' +
    '  cp config.example.json /etc/agent-gate/config.json'
  );
}

/**
 * Deep merge defaults with user config. User values win.
 */
function merge(defaults, user) {
  const result = { ...defaults };
  for (const [key, value] of Object.entries(user)) {
    if (value && typeof value === 'object' && !Array.isArray(value) &&
        defaults[key] && typeof defaults[key] === 'object' && !Array.isArray(defaults[key])) {
      result[key] = merge(defaults[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Validate config. Throws with specific, helpful error messages.
 */
function validate(config) {
  const errors = [];

  if (!config.openVaults.length && !config.gatedVaults.length) {
    errors.push(
      'No vaults configured. Add at least one vault to "openVaults" or "gatedVaults".\n' +
      '  Example: "gatedVaults": ["My-Secrets"]'
    );
  }

  if (config.gatedVaults.length > 0) {
    const channelKeys = Object.keys(config.channels || {});
    if (channelKeys.length === 0) {
      errors.push(
        'Gated vaults require at least one approval channel.\n' +
        '  Add a "channels" section. Example:\n' +
        '  "channels": { "telegram": { "botToken": "...", "chatId": 12345 } }'
      );
    }
  }

  for (const [i, sa] of (config.standingApprovals || []).entries()) {
    if (!sa.item) errors.push(`standingApprovals[${i}]: missing "item"`);
    if (!sa.reasonMatch) errors.push(`standingApprovals[${i}]: missing "reasonMatch"`);
  }

  if (typeof config.approvalTimeoutMs !== 'number' || config.approvalTimeoutMs < 10000) {
    errors.push('approvalTimeoutMs must be at least 10000 (10 seconds)');
  }

  if (errors.length > 0) {
    throw new Error(
      'Configuration errors:\n\n' +
      errors.map((e, i) => `  ${i + 1}. ${e}`).join('\n\n')
    );
  }

  return config;
}

/**
 * Resolve ~ to home directory in a path string.
 */
function resolvePath(p) {
  if (typeof p !== 'string') return p;
  return p.replace(/^~/, process.env.HOME || '/root');
}

module.exports = { load, validate, resolvePath, DEFAULTS };
