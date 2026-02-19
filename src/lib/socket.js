'use strict';

/**
 * Unix socket server and client for agent-gate.
 *
 * Protocol: newline-delimited JSON (JSONL).
 * Each line is a JSON object with an "action" field.
 * Response is a single JSON line per request.
 */

const net = require('net');
const fs = require('fs');

class SocketServer {
  /**
   * @param {string} socketPath - Path to the Unix socket
   * @param {function} handler - async (request) => response
   */
  constructor(socketPath, handler) {
    this.socketPath = socketPath;
    this.handler = handler;
    this.server = null;
    this._started = false;
  }

  /**
   * Start listening on the Unix socket.
   * @returns {Promise<void>}
   */
  start() {
    return new Promise((resolve, reject) => {
      // Clean up stale socket file
      try { fs.unlinkSync(this.socketPath); } catch {}

      this.server = net.createServer((conn) => this._onConnection(conn));

      this.server.on('error', (err) => {
        if (!this._started) reject(err);
        else console.error('[agent-gate] Socket server error:', err.message);
      });

      this.server.listen(this.socketPath, () => {
        this._started = true;
        // Make socket accessible to all local users (agent user needs access)
        try { fs.chmodSync(this.socketPath, 0o666); } catch {}
        resolve();
      });
    });
  }

  _onConnection(conn) {
    let buf = '';

    conn.on('data', (chunk) => {
      buf += chunk.toString();

      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);

        if (!line.trim()) continue;

        let request;
        try {
          request = JSON.parse(line);
        } catch {
          conn.write(JSON.stringify({ error: 'Invalid JSON' }) + '\n');
          continue;
        }

        this.handler(request)
          .then(result => {
            conn.write(JSON.stringify(result) + '\n');
          })
          .catch(err => {
            conn.write(JSON.stringify({ error: err.message }) + '\n');
          });
      }
    });

    conn.on('error', () => {});
  }

  close() {
    if (this.server) {
      this.server.close();
      try { fs.unlinkSync(this.socketPath); } catch {}
    }
  }
}

/**
 * Send a request to the daemon via Unix socket.
 * Used by the CLI.
 *
 * @param {string} socketPath - Path to the Unix socket
 * @param {object} request - Request object
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise<object>} Response object
 */
function sendRequest(socketPath, request, timeoutMs = 310000) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socketPath);
    let buf = '';
    let done = false;

    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        conn.destroy();
        reject(new Error('Request timed out'));
      }
    }, timeoutMs);

    conn.on('connect', () => {
      conn.write(JSON.stringify(request) + '\n');
    });

    conn.on('data', (chunk) => {
      buf += chunk.toString();
      const idx = buf.indexOf('\n');
      if (idx !== -1 && !done) {
        done = true;
        clearTimeout(timer);
        const line = buf.slice(0, idx);
        conn.destroy();
        try {
          resolve(JSON.parse(line));
        } catch {
          reject(new Error(`Invalid response: ${line}`));
        }
      }
    });

    conn.on('error', (err) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

module.exports = { SocketServer, sendRequest };
