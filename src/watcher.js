#!/usr/bin/env node
'use strict';

/**
 * agent-gate watcher — Routes approval callbacks to the daemon.
 *
 * Monitors AI agent session files for approval callback strings
 * (e.g., "ag:approve:abc123def456") and writes them to the daemon's
 * pending directory as JSON files. The daemon polls that directory
 * and resolves the corresponding approval request.
 *
 * This is the bridge between Telegram button taps (which appear in
 * session files via bot update routing) and the daemon's approval
 * flow. Zero token burn — no AI model is invoked.
 *
 * Usage:
 *   node src/watcher.js
 *   AGENT_GATE_PENDING_DIR=/run/agent-gate/pending \
 *   AGENT_GATE_SESSION_DIR=~/.openclaw/agents/main/sessions \
 *     node src/watcher.js
 */

const fs = require('fs');
const path = require('path');

// ─── Config ──────────────────────────────────────────────────────────

const PENDING_DIR = process.env.AGENT_GATE_PENDING_DIR || '/run/agent-gate/pending';
const SESSION_DIR = process.env.AGENT_GATE_SESSION_DIR ||
  path.join(process.env.HOME || '/root', '.openclaw/agents/main/sessions');
const POLL_INTERVAL_MS = parseInt(process.env.AGENT_GATE_POLL_MS || '2000', 10);

// Match callback strings: ag:approve:<hex> or ag:deny:<hex>
const CALLBACK_RE = /ag:(approve|deny):([a-f0-9]{16})/g;

// Track what we've already processed to avoid duplicates
const processed = new Set();

// Track file read positions for incremental reading
const filePositions = new Map();

// ─── Ensure directories ─────────────────────────────────────────────

fs.mkdirSync(PENDING_DIR, { recursive: true });

// ─── Core logic ──────────────────────────────────────────────────────

/**
 * Scan a file for callback strings starting from the last known position.
 */
function scanFile(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return;
  }

  const lastPos = filePositions.get(filePath) || 0;

  // File was truncated or rotated — reset position
  if (stat.size < lastPos) {
    filePositions.set(filePath, 0);
    return scanFile(filePath);
  }

  // No new data
  if (stat.size === lastPos) return;

  // Read only the new portion
  const fd = fs.openSync(filePath, 'r');
  const bufSize = Math.min(stat.size - lastPos, 64 * 1024); // Read at most 64KB at a time
  const buf = Buffer.alloc(bufSize);
  fs.readSync(fd, buf, 0, bufSize, lastPos);
  fs.closeSync(fd);

  filePositions.set(filePath, lastPos + bufSize);

  const chunk = buf.toString('utf8');
  let match;

  while ((match = CALLBACK_RE.exec(chunk)) !== null) {
    const [full, action, requestId] = match;
    const key = `${action}:${requestId}`;

    if (processed.has(key)) continue;
    processed.add(key);

    const approved = action === 'approve';
    const outPath = path.join(PENDING_DIR, `${requestId}.json`);

    try {
      fs.writeFileSync(outPath, JSON.stringify({ approved }));
      const ts = new Date().toISOString();
      console.log(`[agent-gate-watcher] ${ts} Routed: ${full} → ${outPath}`);
    } catch (e) {
      console.error(`[agent-gate-watcher] Failed to write ${outPath}: ${e.message}`);
    }
  }
}

/**
 * Get the most recently modified .jsonl files in the session directory.
 */
function getRecentSessionFiles(count = 3) {
  try {
    const files = fs.readdirSync(SESSION_DIR)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const full = path.join(SESSION_DIR, f);
        try {
          const stat = fs.statSync(full);
          return { path: full, mtime: stat.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, count);

    return files.map(f => f.path);
  } catch {
    return [];
  }
}

// ─── Main loop ───────────────────────────────────────────────────────

function poll() {
  const files = getRecentSessionFiles();
  for (const file of files) {
    scanFile(file);
  }
}

// ─── Try to use fs.watch for efficiency, fall back to polling ─────────

function startWatching() {
  console.log(`[agent-gate-watcher] Started`);
  console.log(`[agent-gate-watcher] Session dir: ${SESSION_DIR}`);
  console.log(`[agent-gate-watcher] Pending dir: ${PENDING_DIR}`);

  let usePolling = false;

  try {
    // Try native fs.watch on the session directory
    const watcher = fs.watch(SESSION_DIR, (eventType, filename) => {
      if (filename && filename.endsWith('.jsonl')) {
        scanFile(path.join(SESSION_DIR, filename));
      }
    });

    watcher.on('error', (e) => {
      console.warn(`[agent-gate-watcher] fs.watch error: ${e.message}, falling back to polling`);
      watcher.close();
      usePolling = true;
      startPolling();
    });

    console.log('[agent-gate-watcher] Using fs.watch (efficient)');

    // Also do periodic polls as a safety net (in case fs.watch misses events)
    setInterval(poll, POLL_INTERVAL_MS * 5);
  } catch (e) {
    console.warn(`[agent-gate-watcher] fs.watch unavailable: ${e.message}, using polling`);
    usePolling = true;
    startPolling();
  }
}

function startPolling() {
  console.log(`[agent-gate-watcher] Polling every ${POLL_INTERVAL_MS}ms`);
  setInterval(poll, POLL_INTERVAL_MS);
}

// ─── Graceful shutdown ───────────────────────────────────────────────

process.on('SIGINT', () => {
  console.log('\n[agent-gate-watcher] Stopped');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('[agent-gate-watcher] Stopped');
  process.exit(0);
});

// ─── Start ───────────────────────────────────────────────────────────

// Initial scan
poll();
startWatching();
