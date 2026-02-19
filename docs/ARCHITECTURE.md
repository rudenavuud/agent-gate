# Architecture

## Threat Model

AI coding agents (Claude Code, Cursor, Codex, etc.) run shell commands on your machine. If an agent can run `op read` or access `~/.env`, it has unrestricted access to every secret on your system.

**The attack**: prompt injection. A malicious instruction hidden in a webpage, codebase, or document can trick the agent into exfiltrating secrets. The agent doesn't even know it's been compromised.

**The defense**: agent-gate. Secrets the agent shouldn't have autonomous access to are locked behind human approval. The agent can request them, but a human must explicitly approve each request on their phone.

## Security Model

```
┌──────────────────────────────────────────────────────────────┐
│  AGENT PROCESS (user: navee)                                 │
│                                                              │
│  ┌─────────────┐    Unix socket     ┌─────────────────────┐ │
│  │  AI Agent    │ ──────────────────▸│  agent-gate daemon  │ │
│  │  (any tool)  │                    │  (user: agent-gate) │ │
│  └─────────────┘                    └────────┬────────────┘ │
│                                              │              │
│  The agent CANNOT:                           │              │
│  • Read the service account token            │              │
│  • Access /proc/PID/environ of daemon        │              │
│  • Bypass the socket protocol                │              │
│                                              │              │
└──────────────────────────────────────────────┼──────────────┘
                                               │
                              ┌────────────────┼────────────┐
                              │                │            │
                              ▼                ▼            │
                        ┌──────────┐   ┌────────────┐      │
                        │ Secret   │   │  Approval  │      │
                        │ Provider │   │  Channel   │      │
                        │ (1Pass)  │   │ (Telegram) │      │
                        └──────────┘   └──────┬─────┘      │
                                              │            │
                                              ▼            │
                                       ┌────────────┐     │
                                       │  Human's   │     │
                                       │   Phone    │     │
                                       │ [✅] [❌] │     │
                                       └────────────┘     │
                                                          │
                              ┌────────────────────────────┘
                              │
                              ▼
                        ┌──────────┐
                        │  Audit   │
                        │   Log    │
                        └──────────┘
```

## Key Design Decisions

### 1. Separate OS User

The daemon runs as a dedicated system user (`agent-gate`). This provides:

- **File permission isolation**: The service account token lives in `/home/agent-gate/` — the agent's user cannot read it.
- **Process isolation**: The agent cannot read `/proc/<daemon-pid>/environ` to extract env vars.
- **No shell**: The `agent-gate` user has `/usr/sbin/nologin` — nobody can log in as it.

### 2. Unix Socket Communication

The agent communicates with the daemon via a Unix domain socket. This provides:

- **Local-only**: No network exposure. The socket is a file on disk.
- **Permission control**: Socket file permissions control who can connect.
- **Simple protocol**: Newline-delimited JSON. Easy to use from any language.
- **No tokens**: The agent doesn't need any credentials to talk to the daemon.

### 3. Open vs Gated Vaults

Secrets are organized into two categories:

- **Open vaults**: Read directly, no approval needed. For low-sensitivity items (search API keys, analytics tokens).
- **Gated vaults**: Require human approval. For high-sensitivity items (payment keys, OAuth tokens, SSH credentials).

### 4. Standing Approvals

Some automated tasks (cron jobs, scheduled scripts) need secrets without human interaction. Standing approvals are pattern-matched rules:

```json
{
  "item": "Stripe Keys",
  "reasonMatch": "cron:*",
  "note": "Scheduled payment reconciliation"
}
```

The reason string must match the pattern. This is audited separately from interactive approvals.

### 5. Provider Abstraction

The daemon doesn't know how to read secrets — it delegates to a **provider**. This makes agent-gate work with any secret backend:

- 1Password (built-in)
- Bitwarden (planned)
- HashiCorp Vault (planned)
- AWS Secrets Manager (planned)
- Environment files (planned)

### 6. Channel Abstraction

Approval notifications are sent via **channels**. Multiple channels can be active simultaneously:

- Telegram (built-in)
- Slack (planned)
- Discord (planned)
- SMS (planned)
- Push notifications (planned)

## Data Flow

### Open Vault Read

```
Agent → CLI → Socket → Daemon → Provider → Secret
                                    ↓
                               Audit Log
```

### Gated Vault Read

```
Agent → CLI → Socket → Daemon → Channel → Human's Phone
                          ↑                      │
                          │     Approve/Deny      │
                          │◂─────────────────────-┘
                          │
                          ↓
                       Provider → Secret
                          ↓
                     Audit Log
```

### Approval Callback Path

```
Human taps button on phone
    ↓
Telegram Bot API callback
    ↓
(one of these paths)
    ├── Watcher → scans session files → writes to pending dir
    ├── HTTP → POST /callback → resolves in-memory
    └── File → direct write to pending dir
    ↓
Daemon polls pending dir (500ms)
    ↓
Approval resolved → secret returned to agent
```

## File Layout (Installed)

```
/opt/agent-gate/          Source code (owned by agent-gate)
/etc/agent-gate/          Config (owned by agent-gate, mode 600)
/run/agent-gate/          Runtime (socket, PID, audit log)
  ├── agent-gate.sock     Unix socket (mode 666 — agent needs access)
  ├── agent-gate.pid      PID file
  ├── audit.log           Audit log (JSONL)
  └── pending/            Pending approval files (mode 777)
/usr/local/bin/agent-gate CLI symlink
/home/agent-gate/         Service account token (mode 600)
```

## Audit Log Format

Every event is a JSON object on its own line:

```jsonl
{"timestamp":"2025-01-15T08:30:00.000Z","action":"daemon_start","pid":12345}
{"timestamp":"2025-01-15T08:30:05.000Z","action":"read","uri":"op://Vault/Key/cred","type":"open","result":"allowed"}
{"timestamp":"2025-01-15T08:31:00.000Z","action":"request","requestId":"abc123","uri":"op://Gated/Stripe/key","type":"gated","result":"pending","reason":"Checking config"}
{"timestamp":"2025-01-15T08:31:15.000Z","action":"approved","requestId":"abc123","uri":"op://Gated/Stripe/key","reason":"Checking config"}
```
