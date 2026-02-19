'use strict';

/**
 * 1Password secret provider.
 *
 * Reads secrets via the `op` CLI. Supports two auth modes:
 *   1. Default auth (op CLI's own session) — for open vaults
 *   2. Service account token — for gated vault reads (isolated credentials)
 *
 * URI format: op://Vault/Item/Field
 *             op://Vault/Item/Section/Field
 *
 * Config:
 *   {
 *     "serviceAccountTokenPath": "/home/agent-gate/service-token",
 *     "opPath": "op"  // optional: custom path to op CLI binary
 *   }
 */

const { execSync } = require('child_process');
const fs = require('fs');
const { BaseProvider } = require('./base');

class OnePasswordProvider extends BaseProvider {
  constructor(config = {}) {
    super(config);
    this._serviceAccountToken = null;
    this._loadServiceAccountToken();
  }

  get name() {
    return 'onepassword';
  }

  /**
   * Load the service account token from disk.
   * Non-fatal if missing — falls back to default op auth.
   */
  _loadServiceAccountToken() {
    const tokenPath = this.config.serviceAccountTokenPath;
    if (!tokenPath) return;

    const resolved = tokenPath.replace(/^~/, process.env.HOME || '/root');
    try {
      this._serviceAccountToken = fs.readFileSync(resolved, 'utf8').trim();
      console.log(`[agent-gate] 1Password service account token loaded from ${resolved}`);
    } catch (e) {
      console.warn(`[agent-gate] WARNING: No service account token at ${resolved}`);
      console.warn('[agent-gate] Gated vault reads will use default op auth (less secure)');
    }
  }

  /**
   * Parse an op:// URI into vault, item, and field.
   */
  parseUri(uri) {
    const match = uri.match(/^op:\/\/([^/]+)\/([^/]+)\/(.+)$/);
    if (!match) return null;
    return { vault: match[1], item: match[2], field: match[3] };
  }

  /**
   * Read a secret from 1Password via the op CLI.
   */
  async read(uri, options = {}) {
    const opBin = this.config.opPath || 'op';
    const env = { ...process.env };

    if (options.useServiceAccount && this._serviceAccountToken) {
      env.OP_SERVICE_ACCOUNT_TOKEN = this._serviceAccountToken;
    }

    try {
      const result = execSync(`${opBin} read "${uri}"`, {
        encoding: 'utf8',
        timeout: 30000,
        stdio: ['pipe', 'pipe', 'pipe'],
        env
      });
      return result.trim();
    } catch (e) {
      throw new Error(`op read failed for ${uri}: ${e.stderr || e.message}`);
    }
  }

  /**
   * Validate that `op` CLI is available.
   */
  async validate() {
    const opBin = this.config.opPath || 'op';
    try {
      execSync(`${opBin} --version`, {
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch {
      throw new Error(
        `1Password CLI (op) not found. Install it:\n` +
        `  https://developer.1password.com/docs/cli/get-started/`
      );
    }
  }
}

module.exports = { OnePasswordProvider };
