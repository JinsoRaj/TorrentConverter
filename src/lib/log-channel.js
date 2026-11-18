import { GrammyError } from 'grammy';
const MAX_MESSAGE_CHARS = 3800;

/**
 * Posts events (new users, groups, errors, broadcast reports) to a Telegram
 * chat of the owner's choosing. Entries are batched into one message every few
 * seconds, which keeps the bot far below Telegram's per-chat rate limits even
 * when lots happens at once.
 */
export class LogChannel {
  #queue = [];
  #timer = null;
  #flushing = null;
  #dropped = 0;

  /**
   * @param {{api: import('grammy').Api, chatId?: number, logger: import('../logger.js').Logger, intervalMs?: number, maxQueue?: number}} options
   */
  constructor({ api, chatId, logger, intervalMs = 3000, maxQueue = 300 }) {
    this.api = api;
    this.chatId = chatId;
    this.logger = logger;
    this.intervalMs = intervalMs;
    this.maxQueue = maxQueue;
  }

  get enabled() {
    return Boolean(this.chatId);
  }

  /** Queue one entry (Telegram HTML). */
  send(html) {
    if (!this.enabled) return;
    if (this.#queue.length >= this.maxQueue || html.length > MAX_MESSAGE_CHARS) {
      // (cutting HTML could leave a tag open, so oversized entries are dropped)
      this.#dropped++;
      return;
    }
    this.#queue.push(html);
    this.#schedule();
  }

  #schedule() {
    if (this.#timer || !this.enabled) return;
    this.#timer = setTimeout(() => this.#flush(), this.intervalMs);
    this.#timer.unref();
  }

  #flush() {
    this.#timer = null;
    if (this.#flushing) return this.#schedule();
    const batch = [];
    let size = 0;
    if (this.#dropped) {
      batch.push(`<i>(${this.#dropped} log entries dropped)</i>`);
      size += 40;
      this.#dropped = 0;
    }
    while (this.#queue.length && size + this.#queue[0].length + 2 <= MAX_MESSAGE_CHARS) {
      const entry = this.#queue.shift();
      batch.push(entry);
      size += entry.length + 2;
    }
    if (!batch.length) return;

    const text = batch.join('\n\n');
    const options = { link_preview_options: { is_disabled: true }, disable_notification: true };
    this.#flushing = this.api
      .sendMessage(this.chatId, text, { ...options, parse_mode: 'HTML' })
      .catch((err) => {
        // If Telegram can't parse the HTML, still deliver the logs as plain text.
        if (err instanceof GrammyError && /can't parse entities/i.test(err.description)) {
          return this.api.sendMessage(this.chatId, text, options);
        }
        throw err;
      })
      .catch((err) => {
        this.logger.warn(`Log channel: could not send (${err.description ?? err.message})`);
        if (err instanceof GrammyError && (err.error_code === 403 || /chat not found/i.test(err.description))) {
          this.logger.warn('Log channel disabled: add the bot to LOG_CHAT_ID as an admin and restart.');
          this.chatId = undefined;
          this.#queue.length = 0;
        }
      })
      .finally(() => {
        this.#flushing = null;
        if (this.#queue.length) this.#schedule();
      });
    return this.#flushing;
  }

  /** Flush whatever is queued (used on shutdown). */
  async close() {
    clearTimeout(this.#timer);
    this.#timer = null;
    await this.#flushing;
    if (this.#queue.length) await this.#flush();
  }
}
