'use strict';

/**
 * Telegram approval channel.
 *
 * Sends approval requests as Telegram messages with inline
 * Approve/Deny buttons. Uses the Bot API directly via https
 * (zero dependencies).
 *
 * Config:
 *   {
 *     "botToken": "123456:ABC-DEF...",
 *     "chatId": 12345678,
 *     "timeZone": "America/Vancouver"
 *   }
 *
 * Callback data format: ag:approve:<requestId> / ag:deny:<requestId>
 * Routed back to the daemon via HTTP, file drop, or the watcher.
 */

const https = require('https');
const { BaseChannel } = require('./base');

class TelegramChannel extends BaseChannel {
  constructor(config = {}) {
    super(config);
    this.botToken = config.botToken;
    this.chatId = config.chatId;
  }

  get name() {
    return 'telegram';
  }

  /**
   * Call the Telegram Bot API.
   */
  _api(method, body) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${this.botToken}/${method}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data)
        }
      }, (res) => {
        let buf = '';
        res.on('data', c => buf += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(buf);
            if (!parsed.ok) reject(new Error(`Telegram API: ${parsed.description}`));
            else resolve(parsed.result);
          } catch {
            reject(new Error(`Telegram parse error: ${buf.slice(0, 200)}`));
          }
        });
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  async sendApprovalRequest({ requestId, item, field, vault, reason }) {
    const time = new Date().toLocaleString('en-US', {
      hour: 'numeric', minute: '2-digit', hour12: true,
      timeZone: this.config.timeZone || 'UTC',
      timeZoneName: 'short'
    });

    const text = [
      '🔐 *Secret Request*',
      '',
      `*Item:* ${esc(item)}`,
      `*Field:* ${esc(field)}`,
      `*Vault:* ${esc(vault)}`,
      `*Reason:* "${esc(reason)}"`,
      `*Time:* ${time}`,
      `*ID:* \`${requestId}\``
    ].join('\n');

    const result = await this._api('sendMessage', {
      chat_id: this.chatId,
      text,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Approve', callback_data: `ag:approve:${requestId}` },
          { text: '❌ Deny', callback_data: `ag:deny:${requestId}` }
        ]]
      }
    });

    return { messageId: result.message_id };
  }

  async updateApprovalMessage(messageRef, approved, { item, field, vault }) {
    const status = approved ? '✅ APPROVED' : '❌ DENIED';
    const time = new Date().toLocaleString('en-US', {
      hour: 'numeric', minute: '2-digit', hour12: true,
      timeZone: this.config.timeZone || 'UTC',
      timeZoneName: 'short'
    });

    const text = [
      `🔐 Secret Request — ${status}`,
      '',
      `*Item:* ${esc(item)}`,
      `*Field:* ${esc(field)}`,
      `*Vault:* ${esc(vault)}`,
      `*Time:* ${time}`
    ].join('\n');

    try {
      await this._api('editMessageText', {
        chat_id: this.chatId,
        message_id: messageRef.messageId,
        text,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [] }
      });
    } catch (e) {
      console.error(`[agent-gate] Failed to update Telegram message: ${e.message}`);
    }
  }

  async validate() {
    if (!this.botToken) {
      throw new Error(
        'Telegram channel: "botToken" is required.\n' +
        '  Get one from @BotFather on Telegram.'
      );
    }
    if (!this.chatId) {
      throw new Error(
        'Telegram channel: "chatId" is required.\n' +
        '  Send /start to your bot, then check:\n' +
        '  https://api.telegram.org/bot<token>/getUpdates'
      );
    }
  }
}

function esc(text) {
  return String(text).replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

module.exports = { TelegramChannel };
