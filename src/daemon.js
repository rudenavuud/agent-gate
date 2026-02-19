#!/usr/bin/env node
'use strict';

/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║                     agent-gate daemon                       ║
 * ║   Human-in-the-loop secret approval for AI agents           ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * The daemon sits between AI agents and your secret store. Agents
 * request secrets via Unix socket. Open vault items are returned
 * directly. Gated vault items require human approval via phone.
 *
 * Start:
 *   node src/daemon.js
 *   AGENT_GATE_CONFIG=/path/to/config.json node src/daemon.js
 *
 * Security model:
 *   Run as a separate OS user (e.g., `agent-gate`) so the agent
 *   process cannot read secret store credentials from disk.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { load: loadConfig, resolvePath } = require('./lib/config');
const { AuditLog } = require('./lib/audit');
const { SocketServer } = require('./lib/socket');

// ─── Provider registry ───────────────────────────────────────────────
// Add new providers here. Lazy-loaded to avoid pulling in unused deps.
const PROVIDER_CLASSES = {
  onepassword: () => require('./providers/onepassword').OnePasswordProvider,
};

// ─── Channel registry ────────────────────────────────────────────────
// Add new channels here.
const CHANNEL_CLASSES = {
  telegram: () => require('./channels/telegram').TelegramChannel,
};

// ─── Load config ─────────────────────────────────────────────────────

const { config, configPath } = loadConfig();

// ─── Initialize components ───────────────────────────────────────────

const audit = new AuditLog(resolvePath(config.auditLogPath));
const PENDING_DIR = resolvePath(config.pendingDir);
const OPEN_VAULTS = new Set(config.openVaults.map(v => v.toLowerCase()));
const GATED_VAULTS = new Set(config.gatedVaults.map(v => v.toLowerCase()));

// Provider
const providerName = config.providers?.default || 'onepassword';
const ProviderClass = PROVIDER_CLASSES[providerName]?.();
if (!ProviderClass) {
  console.error(`[agent-gate] FATAL: Unknown provider "${providerName}"`);
  process.exit(1);
}
const provider = new ProviderClass(config.providers?.[providerName] || {});

// Channels
const channels = [];
for (const [name, channelConfig] of Object.entries(config.channels || {})) {
  const ChannelClass = CHANNEL_CLASSES[name]?.();
  if (!ChannelClass) {
    console.error(`[agent-gate] WARNING: Unknown channel "${name}", skipping`);
    continue;
  }
  channels.push(new ChannelClass(channelConfig));
}

// Standing approvals
const STANDING_APPROVALS = config.standingApprovals || [];

// ─── State ───────────────────────────────────────────────────────────

const pendingRequests = new Map(); // requestId → { resolve, timer, pollInterval }
const cache = new Map();           // uri → { value, expiresAt }

// ─── Ensure directories ─────────────────────────────────────────────

fs.mkdirSync(PENDING_DIR, { recursive: true });
try { fs.chmodSync(PENDING_DIR, 0o777); } catch {}

// ─── Helpers ─────────────────────────────────────────────────────────

function generateRequestId() {
  return crypto.randomBytes(8).toString('hex');
}

function matchesStandingApproval(item, reason) {
  if (!reason) return null;
  for (const sa of STANDING_APPROVALS) {
    if (sa.item !== item) continue;
    const pattern = sa.reasonMatch;
    if (pattern.endsWith('*')) {
      if (reason.startsWith(pattern.slice(0, -1))) return sa;
    } else if (pattern === reason) {
      return sa;
    }
  }
  return null;
}

// ─── Cache ───────────────────────────────────────────────────────────

function getCached(uri) {
  if (config.cacheTTL <= 0) return null;
  const entry = cache.get(uri);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { cache.delete(uri); return null; }
  return entry.value;
}

function setCache(uri, value) {
  if (config.cacheTTL <= 0) return;
  cache.set(uri, { value, expiresAt: Date.now() + config.cacheTTL });
}

// ─── Approval flow ───────────────────────────────────────────────────

function waitForApproval(requestId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup(requestId);
      reject(new Error(`Approval timed out after ${config.approvalTimeoutMs / 1000}s`));
    }, config.approvalTimeoutMs);

    // File-based polling fallback (for watcher integration)
    const pollInterval = setInterval(() => {
      const filePath = path.join(PENDING_DIR, `${requestId}.json`);
      try {
        if (fs.existsSync(filePath)) {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          fs.unlinkSync(filePath);
          clearInterval(pollInterval);
          resolveApproval(requestId, data.approved);
        }
      } catch {}
    }, 500);

    pendingRequests.set(requestId, { resolve, timer, pollInterval });
  });
}

function resolveApproval(requestId, approved) {
  const pending = pendingRequests.get(requestId);
  if (!pending) return false;
  cleanup(requestId);
  pending.resolve(!!approved);
  return true;
}

function cleanup(requestId) {
  const pending = pendingRequests.get(requestId);
  if (!pending) return;
  clearTimeout(pending.timer);
  if (pending.pollInterval) clearInterval(pending.pollInterval);
  pendingRequests.delete(requestId);
  try { fs.unlinkSync(path.join(PENDING_DIR, `${requestId}.json`)); } catch {}
}

// ─── Request handling ────────────────────────────────────────────────

async function handleRequest(request) {
  switch (request.action) {
    case 'read':
      return handleRead(request);
    case 'ping':
      return { status: 'ok', pending: pendingRequests.size };
    case 'status':
      return {
        status: 'running',
        pending: pendingRequests.size,
        cacheSize: cache.size,
        uptime: Math.floor(process.uptime()),
        channels: channels.map(c => c.name),
        provider: provider.name
      };
    default:
      return { error: `Unknown action: ${request.action}` };
  }
}

async function handleRead(request) {
  const { uri, reason } = request;

  if (!uri) return { error: 'Missing "uri" field' };

  const parsed = provider.parseUri(uri);
  if (!parsed) return { error: `Invalid URI: ${uri}` };

  const vaultLower = parsed.vault.toLowerCase();

  // ── Open vault: read directly ──────────────────────────────────────
  if (OPEN_VAULTS.has(vaultLower)) {
    audit.log({
      action: 'read', uri, vault: parsed.vault,
      item: parsed.item, field: parsed.field,
      type: 'open', result: 'allowed'
    });
    try {
      const value = await provider.read(uri);
      return { value };
    } catch (e) {
      audit.log({ action: 'read_error', uri, error: e.message });
      return { error: e.message };
    }
  }

  // ── Gated vault: require approval ──────────────────────────────────
  if (GATED_VAULTS.has(vaultLower)) {
    if (!reason) {
      return { error: 'Reason is REQUIRED for gated vault items. Pass --reason "..."' };
    }

    // Check standing approvals
    const standing = matchesStandingApproval(parsed.item, reason);
    if (standing) {
      audit.log({
        action: 'read', uri, vault: parsed.vault,
        item: parsed.item, field: parsed.field,
        type: 'gated', result: 'standing_approval',
        standingNote: standing.note, reason
      });
      console.log(`[agent-gate] Standing approval: ${parsed.item} (${standing.note})`);
      try {
        const value = await provider.read(uri, { useServiceAccount: true });
        audit.log({
          action: 'read', uri, vault: parsed.vault,
          item: parsed.item, field: parsed.field,
          type: 'gated', result: 'standing_approved_read'
        });
        return { value };
      } catch (e) {
        audit.log({ action: 'read_error', uri, error: e.message });
        return { error: e.message };
      }
    }

    // Check cache
    const cached = getCached(uri);
    if (cached !== null) {
      audit.log({
        action: 'read', uri, vault: parsed.vault,
        item: parsed.item, field: parsed.field,
        type: 'gated', result: 'cache_hit'
      });
      return { value: cached };
    }

    // ── Send approval request to all channels ────────────────────────
    const requestId = generateRequestId();

    audit.log({
      action: 'request', requestId, uri,
      vault: parsed.vault, item: parsed.item,
      field: parsed.field, reason,
      type: 'gated', result: 'pending'
    });

    console.log(`[agent-gate] Pending: ${requestId} for ${parsed.item}/${parsed.field}`);

    const messageRefs = [];
    for (const channel of channels) {
      try {
        const ref = await channel.sendApprovalRequest({
          requestId, item: parsed.item,
          field: parsed.field, vault: parsed.vault, reason
        });
        messageRefs.push({ channel, ref });
      } catch (e) {
        console.error(`[agent-gate] ${channel.name} send failed: ${e.message}`);
        audit.log({ action: 'channel_error', channel: channel.name, requestId, error: e.message });
      }
    }

    if (messageRefs.length === 0 && channels.length > 0) {
      return { error: 'Failed to send approval request to any channel' };
    }

    // Wait for approval
    try {
      const approved = await waitForApproval(requestId);

      // Update all channel messages
      for (const { channel, ref } of messageRefs) {
        try {
          await channel.updateApprovalMessage(ref, approved, {
            item: parsed.item, field: parsed.field, vault: parsed.vault
          });
        } catch {}
      }

      if (!approved) {
        audit.log({
          action: 'denied', requestId, uri,
          vault: parsed.vault, item: parsed.item,
          field: parsed.field, reason
        });
        return { error: 'Request denied by operator' };
      }

      audit.log({
        action: 'approved', requestId, uri,
        vault: parsed.vault, item: parsed.item,
        field: parsed.field, reason
      });

      try {
        const value = await provider.read(uri, { useServiceAccount: true });
        setCache(uri, value);
        audit.log({
          action: 'read', requestId, uri,
          vault: parsed.vault, item: parsed.item,
          field: parsed.field, reason,
          type: 'gated', result: 'approved_read'
        });
        return { value };
      } catch (e) {
        audit.log({ action: 'read_error', requestId, uri, error: e.message });
        return { error: e.message };
      }

    } catch (e) {
      for (const { channel, ref } of messageRefs) {
        try {
          await channel.updateApprovalMessage(ref, false, {
            item: parsed.item, field: parsed.field, vault: parsed.vault
          });
        } catch {}
      }
      audit.log({ action: 'timeout', requestId, uri, reason });
      return { error: e.message };
    }
  }

  return { error: `Vault "${parsed.vault}" is not configured as open or gated` };
}

// ─── HTTP callback server ────────────────────────────────────────────

function startHttpServer() {
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', pending: pendingRequests.size }));
      return;
    }

    // Direct callback: { requestId, approved }
    if (req.method === 'POST' && req.url === '/callback') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (!data.requestId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing requestId' }));
            return;
          }
          const resolved = resolveApproval(data.requestId, data.approved);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, resolved }));
          console.log(`[agent-gate] Callback: ${data.requestId} → ${data.approved ? 'approved' : 'denied'}`);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    // Channel-style callback: { callback_data: "ag:approve:<id>" }
    if (req.method === 'POST' && req.url === '/channel-callback') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          const match = (data.callback_data || '').match(/^ag:(approve|deny):(.+)$/);
          if (!match) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid callback_data' }));
            return;
          }
          const resolved = resolveApproval(match[2], match[1] === 'approve');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, resolved }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(config.httpPort, '127.0.0.1', () => {
    console.log(`[agent-gate] HTTP callback server on http://127.0.0.1:${config.httpPort}`);
  });

  server.on('error', (err) => {
    console.error('[agent-gate] HTTP server error:', err.message);
  });

  return server;
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log('[agent-gate] Starting daemon...');
  console.log(`[agent-gate] Config: ${configPath}`);
  console.log(`[agent-gate] Provider: ${provider.name}`);
  console.log(`[agent-gate] Channels: ${channels.map(c => c.name).join(', ') || 'none'}`);
  console.log(`[agent-gate] Open vaults: ${[...OPEN_VAULTS].join(', ') || 'none'}`);
  console.log(`[agent-gate] Gated vaults: ${[...GATED_VAULTS].join(', ') || 'none'}`);
  console.log(`[agent-gate] Cache TTL: ${config.cacheTTL === 0 ? 'disabled' : config.cacheTTL + 'ms'}`);
  console.log(`[agent-gate] Approval timeout: ${config.approvalTimeoutMs / 1000}s`);

  // Validate provider
  try {
    await provider.validate();
  } catch (e) {
    console.error(`[agent-gate] Provider validation failed: ${e.message}`);
    process.exit(1);
  }

  // Validate channels
  for (const channel of channels) {
    try {
      await channel.validate();
    } catch (e) {
      console.error(`[agent-gate] Channel ${channel.name} validation failed: ${e.message}`);
      process.exit(1);
    }
  }

  // Write PID file
  const pidPath = config.pidFile || '/run/agent-gate/agent-gate.pid';
  try {
    fs.mkdirSync(path.dirname(pidPath), { recursive: true });
    fs.writeFileSync(pidPath, String(process.pid));
  } catch (e) {
    console.warn(`[agent-gate] Could not write PID file: ${e.message}`);
  }

  // Start servers
  const socketServer = new SocketServer(config.socketPath, handleRequest);
  await socketServer.start();
  console.log(`[agent-gate] Unix socket: ${config.socketPath}`);

  const httpServer = startHttpServer();

  audit.log({ action: 'daemon_start', pid: process.pid, config: configPath });

  // Graceful shutdown
  function shutdown(signal) {
    console.log(`\n[agent-gate] ${signal}, shutting down...`);
    audit.log({ action: 'daemon_stop', signal, pid: process.pid });

    for (const [id] of pendingRequests) {
      const pending = pendingRequests.get(id);
      cleanup(id);
      pending?.resolve?.(false);
    }
    pendingRequests.clear();

    socketServer.close();
    httpServer.close();
    try { fs.unlinkSync(pidPath); } catch {}

    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  console.log(`[agent-gate] Daemon ready (PID: ${process.pid})`);
}

main().catch(e => {
  console.error(`[agent-gate] FATAL: ${e.message}`);
  process.exit(1);
});
