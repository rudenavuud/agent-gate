'use strict';

/**
 * Base approval channel interface.
 *
 * An approval channel sends a request to a human and waits for
 * their response (approve/deny). Multiple channels can be active
 * simultaneously (e.g., Telegram + Slack).
 *
 * To create a new channel:
 *   1. Create a new file in src/channels/
 *   2. Extend BaseChannel
 *   3. Implement sendApprovalRequest() and updateApprovalMessage()
 *   4. Register it in CHANNEL_CLASSES in src/daemon.js
 *
 * See docs/CHANNELS.md for the full guide.
 */

class BaseChannel {
  constructor(config = {}) {
    this.config = config;
  }

  /** Channel name for logging. */
  get name() {
    return 'base';
  }

  /**
   * Send an approval request to the human.
   * @param {object} params - { requestId, item, field, vault, reason }
   * @returns {Promise<object>} Message reference (e.g., { messageId })
   */
  async sendApprovalRequest(params) {
    throw new Error(`${this.name}: sendApprovalRequest() not implemented`);
  }

  /**
   * Update the approval message with the outcome.
   * @param {object} messageRef - Reference from sendApprovalRequest()
   * @param {boolean} approved
   * @param {object} params - { item, field, vault }
   */
  async updateApprovalMessage(messageRef, approved, params) {
    // Default: no-op. Not all channels support message editing.
  }

  /**
   * Validate channel configuration at daemon startup.
   */
  async validate() {}
}

module.exports = { BaseChannel };
