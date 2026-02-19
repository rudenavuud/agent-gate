#!/usr/bin/env node
'use strict';

/**
 * agent-gate CLI — Talk to the agent-gate daemon.
 *
 * Usage:
 *   agent-gate read "op://Vault/Item/field" --reason "why"
 *   agent-gate status
 *   agent-gate ping
 *   agent-gate approve <request-id>
 *   agent-gate deny <request-id>
 *   agent-gate help
 */

const { sendRequest } = require('./lib/socket');
const fs = require('fs');
const path = require('path');

// ─── Config ──────────────────────────────────────────────────────────

const RUN_BASE = process.platform === 'darwin' ? '/var/run/agent-gate' : '/run/agent-gate';
const DEFAULT_SOCKET = `${RUN_BASE}/agent-gate.sock`;
const SOCKET_PATH = process.env.AGENT_GATE_SOCKET || DEFAULT_SOCKET;
const TIMEOUT_MS = 310000; // 5min approval + 10s buffer

// ─── Helpers ─────────────────────────────────────────────────────────

function getVersion() {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
    );
    return pkg.version;
  } catch {
    return 'unknown';
  }
}

function die(msg) {
  process.stderr.write(`agent-gate: ${msg}\n`);
  process.exit(1);
}

function checkDaemon() {
  try {
    const stat = fs.statSync(SOCKET_PATH);
    if (!stat.isSocket()) die(`${SOCKET_PATH} exists but is not a socket`);
  } catch (e) {
    if (e.code === 'ENOENT') {
      die(
        `Daemon not running (no socket at ${SOCKET_PATH}).\n` +
        'Start with: sudo systemctl start agent-gate'
      );
    }
    die(`Cannot access socket: ${e.message}`);
  }
}

async function send(request) {
  try {
    return await sendRequest(SOCKET_PATH, request, TIMEOUT_MS);
  } catch (e) {
    if (e.code === 'ECONNREFUSED' || e.code === 'ENOENT') {
      die('Daemon not running. Start with: sudo systemctl start agent-gate');
    }
    die(`Connection failed: ${e.message}`);
  }
}

// ─── Commands ────────────────────────────────────────────────────────

async function cmdRead(args) {
  let uri = null;
  let reason = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--reason' || arg === '-r') {
      reason = args[++i];
      if (!reason) die('--reason requires a value');
    } else if (arg.startsWith('--reason=')) {
      reason = arg.slice('--reason='.length);
    } else if (arg.startsWith('-')) {
      die(`Unknown option: ${arg}`);
    } else if (!uri) {
      uri = arg;
    } else {
      die(`Unexpected argument: ${arg}`);
    }
  }

  if (!uri) die('Usage: agent-gate read "op://Vault/Item/field" [--reason "..."]');
  if (!uri.startsWith('op://')) die('URI must start with op://');

  checkDaemon();

  const request = { action: 'read', uri };
  if (reason) request.reason = reason;

  const response = await send(request);

  if (response.error) die(response.error);
  if (response.value !== undefined) {
    process.stdout.write(response.value);
    if (process.stdout.isTTY) process.stdout.write('\n');
  } else {
    die(`Unexpected response: ${JSON.stringify(response)}`);
  }
}

async function cmdStatus() {
  checkDaemon();
  const response = await send({ action: 'status' });
  if (response.error) die(response.error);

  console.log([
    `Status:   ${response.status}`,
    `Uptime:   ${formatUptime(response.uptime)}`,
    `Pending:  ${response.pending} request(s)`,
    `Cache:    ${response.cacheSize} entries`,
    `Provider: ${response.provider}`,
    `Channels: ${response.channels?.join(', ') || 'none'}`
  ].join('\n'));
}

async function cmdPing() {
  checkDaemon();
  const response = await send({ action: 'ping' });
  if (response.status === 'ok') {
    console.log(`agent-gate daemon is running (${response.pending} pending)`);
  } else {
    die(`Unexpected: ${JSON.stringify(response)}`);
  }
}

async function cmdApprove(args, approved) {
  const requestId = args[0];
  if (!requestId) die(`Usage: agent-gate ${approved ? 'approve' : 'deny'} <request-id>`);

  const http = require('http');
  const data = JSON.stringify({ requestId, approved });

  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: 18891,
      path: '/callback',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try {
          const result = JSON.parse(buf);
          if (result.ok) {
            console.log(result.resolved
              ? `Request ${requestId} ${approved ? 'approved' : 'denied'}`
              : `No pending request with ID ${requestId}`
            );
          } else {
            die(result.error || 'Unknown error');
          }
        } catch {
          die(`Invalid response: ${buf}`);
        }
        resolve();
      });
    });
    req.on('error', (e) => die(`Could not reach daemon: ${e.message}`));
    req.write(data);
    req.end();
  });
}

function formatUptime(seconds) {
  if (seconds == null) return 'unknown';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

// ─── Help ────────────────────────────────────────────────────────────

function showHelp() {
  console.log(`agent-gate v${getVersion()} — Human-in-the-loop secret approval for AI agents

Usage:
  agent-gate read <uri> [--reason "..."]   Read a secret (may require approval)
  agent-gate status                        Show daemon status
  agent-gate ping                          Check if daemon is running
  agent-gate approve <request-id>          Approve a pending request
  agent-gate deny <request-id>             Deny a pending request
  agent-gate version                       Show version
  agent-gate help                          Show this help

Options:
  --reason, -r    Reason for accessing the secret (REQUIRED for gated vaults)

Environment:
  AGENT_GATE_SOCKET  Path to daemon socket (default: ${DEFAULT_SOCKET})

Examples:
  agent-gate read "op://Vault/API-Key/credential"
  agent-gate read "op://Gated/Stripe/secret-key" --reason "Checking webhook config"
  agent-gate status

Learn more: https://github.com/rudenavuud/agent-gate`);
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const rest = args.slice(1);

  switch (command) {
    case 'read':       return cmdRead(rest);
    case 'status':     return cmdStatus();
    case 'ping':       return cmdPing();
    case 'approve':    return cmdApprove(rest, true);
    case 'deny':       return cmdApprove(rest, false);
    case 'version':
    case '--version':
    case '-v':         console.log(getVersion()); return;
    case 'help':
    case '--help':
    case '-h':
    case undefined:    showHelp(); return;
    default:           die(`Unknown command: ${command}. Run 'agent-gate help' for usage.`);
  }
}

main().catch(e => die(e.message));
