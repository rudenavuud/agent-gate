# agent-gate

**Human-in-the-loop secret approval for AI agents.**

Your AI coding agent can run any shell command on your machine. That means it can read every secret you have — API keys, tokens, credentials, SSH keys. One prompt injection attack and they're all exfiltrated.

agent-gate fixes this. Sensitive secrets require your explicit approval on your phone before the agent can access them. Every request is audit-logged.

```
┌─────────┐    ┌──────────────┐    ┌────────────┐    ┌──────────┐
│ AI Agent │───▸│  agent-gate  │───▸│  Telegram   │───▸│  Your    │
│          │◂───│   daemon     │◂───│  (or Slack) │◂───│  Phone   │
└─────────┘    └──────────────┘    └────────────┘    │ [✅] [❌]│
   Can only         Has the            Sends            You tap
   ask for         credentials        approval         Approve
   secrets                            request          or Deny
```

## Why This Matters

**Prompt injection is the #1 attack vector for AI agents.** A malicious instruction hidden in a webpage, codebase, or document can trick the agent into running commands it shouldn't. If your agent has direct access to `op read`, your Stripe keys, OAuth tokens, and SSH credentials are one injection away from exfiltration.

agent-gate ensures that even a fully compromised agent cannot access sensitive secrets without your real-time approval.

## How It Works

1. **The daemon runs as a separate OS user** — the AI agent physically cannot read the secret store credentials
2. **The agent talks to the daemon via Unix socket** — it can request secrets but not bypass approval
3. **You get a phone notification** — tap ✅ Approve or ❌ Deny
4. **Everything is audit-logged** — who requested what, when, and whether it was approved

## Quick Start

### Install

```bash
# Clone and install
git clone https://github.com/rudenavuud/agent-gate.git
cd agent-gate
sudo bash install.sh
```

### Configure

```bash
sudo cp config.example.json /etc/agent-gate/config.json
sudo nano /etc/agent-gate/config.json
```

Set your approval channel (e.g., Telegram bot token + chat ID) and define which vaults are open vs gated:

```json
{
  "openVaults": ["Low-Sensitivity"],
  "gatedVaults": ["Production-Secrets"],
  "channels": {
    "telegram": {
      "botToken": "YOUR_BOT_TOKEN",
      "chatId": YOUR_CHAT_ID
    }
  },
  "providers": {
    "default": "onepassword",
    "onepassword": {
      "serviceAccountTokenPath": "/home/agent-gate/service-token"
    }
  }
}
```

### Start

```bash
# Linux (systemd)
sudo systemctl enable --now agent-gate

# macOS (launchd)
sudo launchctl load /Library/LaunchDaemons/com.agent-gate.daemon.plist
```

### Use

```bash
# Open vault — returned immediately, no approval needed
agent-gate read "op://Low-Sensitivity/Search-API/key"

# Gated vault — sends approval request to your phone
agent-gate read "op://Production-Secrets/Stripe/secret-key" --reason "Checking webhook config"
# ⏳ Waiting for approval...
# ✅ Approved → returns the secret
```

## Architecture

```
 Your Machine
 ┌──────────────────────────────────────────────────────────────┐
 │                                                              │
 │  ┌─────────────────┐          ┌───────────────────────────┐ │
 │  │   AI Agent       │  Unix   │   agent-gate daemon        │ │
 │  │   (user: you)    │──sock──▸│   (user: agent-gate)      │ │
 │  │                  │         │                            │ │
 │  │  Cannot read:    │         │  Has access to:            │ │
 │  │  • service token │         │  • 1Password service acct  │ │
 │  │  • daemon env    │         │  • Secret provider creds   │ │
 │  │  • secret store  │         │  • Approval channel tokens │ │
 │  └─────────────────┘         └─────────┬──────────────────┘ │
 │                                        │                    │
 └────────────────────────────────────────┼────────────────────┘
                                          │
                    ┌─────────────────────┼──────────────────┐
                    │                     │                  │
                    ▼                     ▼                  ▼
              ┌──────────┐        ┌────────────┐     ┌──────────┐
              │ 1Password │        │  Telegram   │     │  Audit   │
              │ (or any   │        │  (or any    │     │   Log    │
              │  provider)│        │   channel)  │     │  (JSONL) │
              └──────────┘        └────────────┘     └──────────┘
```

### Security Boundaries

| What | Why |
|------|-----|
| Separate OS user | Agent can't read service account token from filesystem |
| Unix socket only | No network exposure, no auth tokens needed |
| Process isolation | Agent can't read `/proc/<pid>/environ` of daemon |
| Audit log | Every request, approval, and denial is recorded |
| Approval timeout | Requests expire after 5 minutes (configurable) |

## Configuration Reference

| Field | Default | Description |
|-------|---------|-------------|
| `socketPath` | `/run/agent-gate/agent-gate.sock` | Unix socket path |
| `httpPort` | `18891` | HTTP callback server port (localhost only) |
| `approvalTimeoutMs` | `300000` (5 min) | How long to wait for approval |
| `cacheTTL` | `0` (disabled) | Cache approved secrets (ms) |
| `openVaults` | `[]` | Vaults that don't require approval |
| `gatedVaults` | `[]` | Vaults that require human approval |
| `providers.default` | `"onepassword"` | Secret provider to use |
| `channels` | `{}` | Approval channels (telegram, slack, etc.) |
| `standingApprovals` | `[]` | Auto-approve rules for cron/automation |
| `auditLogPath` | `/run/agent-gate/audit.log` | Audit log location |
| `pendingDir` | `/run/agent-gate/pending` | Pending approval file directory |

### Standing Approvals

For cron jobs and automated tasks that need secrets without human interaction:

```json
{
  "standingApprovals": [
    {
      "item": "Stripe Keys",
      "reasonMatch": "cron:*",
      "note": "Scheduled payment reconciliation"
    },
    {
      "item": "Analytics Token",
      "reasonMatch": "cron:daily-report",
      "note": "Daily analytics digest"
    }
  ]
}
```

The `reasonMatch` field supports exact match or prefix glob (`pattern*`). Standing approvals are audited with `result: "standing_approval"`.

## CLI Reference

```
agent-gate read <uri> [--reason "..."]   Read a secret
agent-gate status                        Show daemon status
agent-gate ping                          Check if daemon is running
agent-gate approve <request-id>          Approve a pending request
agent-gate deny <request-id>             Deny a pending request
agent-gate version                       Show version
agent-gate help                          Show help
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `AGENT_GATE_SOCKET` | Override default socket path |
| `AGENT_GATE_CONFIG` | Override config file location |
| `AGENT_GATE_PENDING_DIR` | Pending dir for watcher |
| `AGENT_GATE_SESSION_DIR` | Session files dir for watcher |

## Works With Any AI Agent

agent-gate works with any tool that can run shell commands:

- **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)** — Anthropic's CLI
- **[Cursor](https://cursor.sh)** — AI code editor
- **[OpenClaw](https://github.com/nichochar/openclaw)** — AI agent framework
- **[Codex](https://openai.com/index/openai-codex)** — OpenAI's coding agent
- **[Aider](https://aider.chat)** — AI pair programming
- **[Continue](https://continue.dev)** — Open-source AI code assistant
- Any tool that can run `agent-gate read "op://..."` in a shell

## Extending

### Add a Secret Provider

agent-gate ships with 1Password support. Adding Bitwarden, HashiCorp Vault, AWS Secrets Manager, or any other backend is straightforward:

1. Create `src/providers/my-provider.js` extending `BaseProvider`
2. Implement `parseUri()` and `read()`
3. Register in `src/daemon.js`

See [docs/PROVIDERS.md](docs/PROVIDERS.md) for the full guide.

### Add an Approval Channel

Adding Slack, Discord, SMS, or push notifications:

1. Create `src/channels/my-channel.js` extending `BaseChannel`
2. Implement `sendApprovalRequest()`
3. Register in `src/daemon.js`

See [docs/CHANNELS.md](docs/CHANNELS.md) for the full guide.

## Design Principles

- **Zero dependencies** — Only Node.js built-ins (`net`, `http`, `https`, `fs`, `crypto`, `child_process`). No `node_modules`.
- **Provider-agnostic** — Clean interface for any secret backend.
- **Channel-agnostic** — Clean interface for any notification service.
- **One-line install** — `sudo bash install.sh` handles everything.
- **Works with ANY agent** — If it can run shell commands, it works.
- **Audit everything** — JSONL log of every request, approval, and denial.

## The Watcher

The watcher (`src/watcher.js`) monitors AI agent session files for approval callback strings. When you tap Approve on Telegram, the callback data (`ag:approve:<id>`) appears in the agent's session file. The watcher picks it up and writes it to the daemon's pending directory.

This provides a zero-token-burn callback path — no AI model invocation needed.

```bash
# Install as user service (runs as the AI agent's user)
cp systemd/agent-gate-watcher.service ~/.config/systemd/user/
systemctl --user enable --now agent-gate-watcher
```

## License

[MIT](LICENSE)
