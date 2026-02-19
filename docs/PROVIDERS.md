# Adding a Secret Provider

agent-gate uses a provider abstraction to support multiple secret backends. This guide explains how to add a new one.

## Built-in Providers

| Provider | Status | Config key |
|----------|--------|------------|
| 1Password | ✅ Built-in | `onepassword` |
| Bitwarden | 🔜 Planned | `bitwarden` |
| HashiCorp Vault | 🔜 Planned | `vault` |
| AWS Secrets Manager | 🔜 Planned | `aws-secrets` |
| Doppler | 🔜 Planned | `doppler` |
| .env files | 🔜 Planned | `dotenv` |

## Provider Interface

Every provider extends `BaseProvider` from `src/providers/base.js`:

```javascript
const { BaseProvider } = require('./base');

class MyProvider extends BaseProvider {
  get name() {
    return 'my-provider';
  }

  /**
   * Parse a secret URI into components.
   * Return null if the format is not recognized.
   */
  parseUri(uri) {
    // Example: myprovider://project/secret-name
    const match = uri.match(/^myprovider:\/\/([^/]+)\/(.+)$/);
    if (!match) return null;
    return {
      vault: match[1],    // Used for open/gated vault matching
      item: match[2],     // Used in approval messages + standing approvals
      field: 'value'      // Used in approval messages
    };
  }

  /**
   * Read a secret value. Must return a string.
   * options.useServiceAccount is true for gated vault reads.
   */
  async read(uri, options = {}) {
    // Your secret-reading logic here
    return 'the-secret-value';
  }

  /**
   * Optional: validate configuration at startup.
   * Throw an Error with a helpful message if misconfigured.
   */
  async validate() {
    // Check that required tools/credentials are available
  }
}

module.exports = { MyProvider };
```

## Registration

Register your provider in `src/daemon.js`:

```javascript
const PROVIDER_CLASSES = {
  onepassword: () => require('./providers/onepassword').OnePasswordProvider,
  'my-provider': () => require('./providers/my-provider').MyProvider,  // Add this
};
```

## Configuration

Provider config goes in the `providers` section of `config.json`:

```json
{
  "providers": {
    "default": "my-provider",
    "my-provider": {
      "apiKey": "...",
      "endpoint": "..."
    }
  }
}
```

The provider receives its config object in the constructor:

```javascript
constructor(config) {
  super(config);
  this.apiKey = config.apiKey;
  this.endpoint = config.endpoint;
}
```

## URI Design

The `parseUri()` return object must include a `vault` field. This is what agent-gate uses to determine if the secret is in an open or gated vault. The `item` field is used for standing approval matching and approval messages.

Design your URI format to be:
- Human-readable
- Unambiguous (can distinguish vault/item/field)
- Compatible with the underlying tool's native format

## Example: Bitwarden Provider

```javascript
const { execSync } = require('child_process');
const { BaseProvider } = require('./base');

class BitwardenProvider extends BaseProvider {
  get name() { return 'bitwarden'; }

  parseUri(uri) {
    // bw://folder/item-name/field
    const match = uri.match(/^bw:\/\/([^/]+)\/([^/]+)\/(.+)$/);
    if (!match) return null;
    return { vault: match[1], item: match[2], field: match[3] };
  }

  async read(uri, options = {}) {
    const parsed = this.parseUri(uri);
    const result = execSync(
      `bw get item "${parsed.item}" | jq -r '.fields[] | select(.name=="${parsed.field}") | .value'`,
      { encoding: 'utf8', timeout: 30000 }
    );
    return result.trim();
  }

  async validate() {
    try {
      execSync('bw --version', { stdio: 'pipe' });
    } catch {
      throw new Error('Bitwarden CLI (bw) not found. Install: npm install -g @bitwarden/cli');
    }
  }
}

module.exports = { BitwardenProvider };
```

## Security Notes

- **Service account tokens**: If your provider supports separate read-only tokens, use `options.useServiceAccount` to distinguish between open (agent's own auth) and gated (elevated auth) reads.
- **Credential storage**: Store provider credentials in files owned by the `agent-gate` user with mode 600. The agent user should not be able to read them.
- **Timeouts**: Always set timeouts on external calls to prevent the daemon from hanging.
