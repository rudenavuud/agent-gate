'use strict';

/**
 * Audit logging.
 *
 * Append-only JSONL audit log. Every secret request, approval,
 * denial, and system event is recorded with timestamps.
 *
 * Format: one JSON object per line (newline-delimited JSON / JSONL)
 * Fields: timestamp, action, + action-specific fields
 */

const fs = require('fs');
const path = require('path');

class AuditLog {
  /**
   * @param {string} logPath - Path to the audit log file
   */
  constructor(logPath) {
    this.logPath = logPath;
    this._ensureDir();
  }

  _ensureDir() {
    const dir = path.dirname(this.logPath);
    fs.mkdirSync(dir, { recursive: true });
  }

  /**
   * Write an audit entry. Automatically adds timestamp.
   * @param {object} entry - Audit entry fields
   */
  log(entry) {
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      ...entry
    }) + '\n';

    try {
      fs.appendFileSync(this.logPath, line);
    } catch (e) {
      // Log to stderr as fallback — never lose audit events silently
      process.stderr.write(`[agent-gate] AUDIT WRITE FAILED: ${e.message}\n`);
      process.stderr.write(`[agent-gate] AUDIT ENTRY: ${line}`);
    }
  }

  /**
   * Read recent audit entries.
   * @param {number} count - Number of recent entries to return
   * @returns {object[]} Parsed entries (newest last)
   */
  recent(count = 50) {
    try {
      const content = fs.readFileSync(this.logPath, 'utf8');
      const lines = content.trim().split('\n').filter(Boolean);
      return lines.slice(-count).map(line => {
        try { return JSON.parse(line); }
        catch { return { raw: line }; }
      });
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  }
}

module.exports = { AuditLog };
