# Adding an Approval Channel

agent-gate uses a channel abstraction for sending approval requests to humans. Multiple channels can be active simultaneously.

## Built-in Channels

| Channel | Status | Config key |
|---------|--------|------------|
| Telegram | ✅ Built-in | `telegram` |
| Slack | 🔜 Planned | `slack` |
| Discord | 🔜 Planned | `discord` |
| SMS (Twilio) | 🔜 Planned | `sms` |
| Email | 🔜 Planned | `email` |
| Ntfy.sh | 🔜 Planned | `ntfy` |
| Pushover | 🔜 Planned | `pushover` |

## Channel Interface

Every channel extends `BaseChannel` from `src/channels/base.js`:

```javascript
const { BaseChannel } = require('./base');

class MyChannel extends BaseChannel {
  get name() {
    return 'my-channel';
  }

  /**
   * Send an approval request to the human.
   * Return a message reference for later updates.
   */
  async sendApprovalRequest({ requestId, item, field, vault, reason }) {
    // Send notification to the human
    // Include requestId so they can approve/deny
    
    const messageId = await sendNotification({
      title: `Secret Request: ${item}`,
      body: `Field: ${field}\nVault: ${vault}\nReason: ${reason}`,
      actions: [
        { label: 'Approve', data: `ag:approve:${requestId}` },
        { label: 'Deny', data: `ag:deny:${requestId}` }
      ]
    });

    return { messageId };
  }

  /**
   * Optional: Update the message with the outcome.
   */
  async updateApprovalMessage(messageRef, approved, { item, field, vault }) {
    await updateNotification(messageRef.messageId, {
      title: `${approved ? '✅' : '❌'} ${item} — ${approved ? 'Approved' : 'Denied'}`
    });
  }

  /**
   * Optional: Validate config at startup.
   */
  async validate() {
    if (!this.config.apiKey) {
      throw new Error('my-channel: "apiKey" is required');
    }
  }
}

module.exports = { MyChannel };
```

## Registration

Register your channel in `src/daemon.js`:

```javascript
const CHANNEL_CLASSES = {
  telegram: () => require('./channels/telegram').TelegramChannel,
  'my-channel': () => require('./channels/my-channel').MyChannel,  // Add this
};
```

## Configuration

Channel config goes in the `channels` section of `config.json`:

```json
{
  "channels": {
    "telegram": { "botToken": "...", "chatId": 12345 },
    "my-channel": { "apiKey": "...", "userId": "..." }
  }
}
```

Multiple channels can be active. The daemon sends approval requests to **all** configured channels simultaneously. The first response wins.

## Callback Routing

When the human taps Approve/Deny, the response needs to reach the daemon. There are three paths:

### 1. HTTP Callback (recommended)

POST to `http://127.0.0.1:18891/callback`:

```json
{ "requestId": "abc123def456", "approved": true }
```

### 2. File Drop

Write to `/run/agent-gate/pending/<requestId>.json`:

```json
{ "approved": true }
```

The daemon polls this directory every 500ms.

### 3. Callback String in Session Files

If the callback data (`ag:approve:<id>` or `ag:deny:<id>`) appears in an AI agent's session file, the **watcher** service picks it up and routes it.

This is particularly useful for channels that relay button taps back through the AI agent's session (like Telegram bots integrated with AI agent frameworks).

## Example: Slack Channel

```javascript
const https = require('https');
const { BaseChannel } = require('./base');

class SlackChannel extends BaseChannel {
  get name() { return 'slack'; }

  async sendApprovalRequest({ requestId, item, field, vault, reason }) {
    const blocks = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `🔐 *Secret Request*\n*Item:* ${item}\n*Field:* ${field}\n*Vault:* ${vault}\n*Reason:* ${reason}` }
      },
      {
        type: 'actions',
        elements: [
          { type: 'button', text: { type: 'plain_text', text: '✅ Approve' }, action_id: `ag:approve:${requestId}`, style: 'primary' },
          { type: 'button', text: { type: 'plain_text', text: '❌ Deny' }, action_id: `ag:deny:${requestId}`, style: 'danger' }
        ]
      }
    ];

    const result = await this._api('chat.postMessage', {
      channel: this.config.channelId,
      blocks
    });

    return { ts: result.ts, channel: result.channel };
  }

  async validate() {
    if (!this.config.botToken) throw new Error('Slack: "botToken" required');
    if (!this.config.channelId) throw new Error('Slack: "channelId" required');
  }

  async _api(method, body) {
    // Slack Web API call...
  }
}
```

## Design Guidelines

1. **Zero dependencies**: Use Node.js built-ins (`https`, `http`). No npm packages.
2. **Timeout handling**: External API calls should have reasonable timeouts.
3. **Graceful failures**: If a channel fails, the daemon still works (other channels, file-based polling).
4. **Helpful validation**: `validate()` should throw errors with specific fix instructions.
5. **Callback data format**: Use `ag:approve:<requestId>` and `ag:deny:<requestId>` for consistency.
