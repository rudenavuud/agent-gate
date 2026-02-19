'use strict';

/**
 * Base secret provider interface.
 *
 * All providers must implement this interface. A provider reads
 * secrets from a specific backend (1Password, Bitwarden,
 * HashiCorp Vault, AWS Secrets Manager, etc).
 *
 * To create a new provider:
 *   1. Create a new file in src/providers/
 *   2. Extend BaseProvider
 *   3. Implement parseUri() and read()
 *   4. Register it in PROVIDER_CLASSES in src/daemon.js
 *
 * See docs/PROVIDERS.md for the full guide.
 */

class BaseProvider {
  /**
   * @param {object} config - Provider-specific configuration
   */
  constructor(config = {}) {
    this.config = config;
  }

  /**
   * Provider name (for logging and error messages).
   * @returns {string}
   */
  get name() {
    return 'base';
  }

  /**
   * Parse a secret reference URI into components.
   * @param {string} uri - Secret reference (e.g., "op://Vault/Item/Field")
   * @returns {object|null} Parsed components { vault, item, field, ... } or null
   */
  parseUri(uri) {
    throw new Error(`${this.name}: parseUri() not implemented`);
  }

  /**
   * Read a secret value.
   * @param {string} uri - Secret reference
   * @param {object} options
   * @param {boolean} options.useServiceAccount - Use elevated credentials
   * @returns {Promise<string>} The secret value
   */
  async read(uri, options = {}) {
    throw new Error(`${this.name}: read() not implemented`);
  }

  /**
   * Validate that the provider is configured and working.
   * Called at daemon startup.
   * @returns {Promise<void>}
   */
  async validate() {
    // Override if the provider needs startup checks.
  }
}

module.exports = { BaseProvider };
