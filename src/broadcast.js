// Owner broadcasts: copy one message to every user (and optionally group),
// paced well under Telegram's limits, resumable across restarts.

import { GrammyError, HttpError } from 'grammy';
import * as texts from './texts.js';

const PHASES = { users: ['users'], all: ['users', 'chats'] };
const STATUS_EVERY_MS = 10_000;
const MAX_ATTEMPTS = 5;

// Errors meaning "this chat will never receive messages from us again".
const UNREACHABLE =
  /bot was blocked|user is deactivated|chat not found|PEER_ID_INVALID|bot was kicked|bot is not a member|have no rights|not enough rights|CHAT_WRITE_FORBIDDEN|CHAT_RESTRICTED|group chat was upgraded|chat was deleted/i;
const SOURCE_MISSING = /message to copy not found|MESSAGE_ID_INVALID|message can't be copied/i;
const MAX_FAILURES_IN_A_ROW = 25;

class StopSignal extends Error {}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export class Broadcaster {
  /** @type {{b: object, controller: AbortController, done: Promise<void>} | null} */
  #current = null;

  /**
   * @param {object} options
   * @param {import('grammy').Api} options.api
   * @param {import('./lib/db.js').Store} options.store
   * @param {import('./logger.js').Logger} options.logger
   * @param {import('./lib/log-channel.js').LogChannel} options.logChannel
   * @param {number} [options.ratePerSecond] messages per second (Telegram allows ~30/s)
   */
  constructor({ api, store, logger, logChannel, ratePerSecond = 20 }) {
    this.api = api;
    this.store = store;
    this.logger = logger;
    this.logChannel = logChannel;
    this.ratePerSecond = ratePerSecond;
  }

  /** The broadcast currently being sent, if any. */
  get current() {
    return this.#current?.b;
  }

  audienceSize(audience) {
    const c = this.store.counts();
    return audience === 'all' ? c.activeUsers + c.activeChats : c.activeUsers;
  }

  /** Create and start a broadcast. Returns its database row. */
  start({ fromChatId, messageId, audience, statusChatId, statusMessageId }) {
    if (this.#current) throw new Error(`Broadcast #${this.#current.b.id} is still running`);
    const b = this.store.createBroadcast({
      fromChatId,
      messageId,
      audience,
      total: this.audienceSize(audience),
      statusChatId,
      statusMessageId,
    });
    this.logger.info(`Broadcast #${b.id} started for ${b.total} chats (${audience})`);
    this.logChannel.send(texts.logBroadcastStarted(b));
    this.#launch(b);
    return b;
  }

  /** Continue broadcasts that were interrupted by a restart. */
  resume() {
    const [first, ...rest] = this.store.runningBroadcasts();
    for (const extra of rest) this.store.finishBroadcast(extra.id, 'failed', 'Superseded by another broadcast');
    if (first && !this.#current) {
      this.logger.info(`Resuming broadcast #${first.id} (${first.sent + first.failed + first.unreachable}/${first.total} done)`);
      this.#launch(first);
    }
  }

  cancel(id) {
    if (this.#current?.b.id !== id) return false;
    this.#current.controller.abort(new StopSignal('cancel'));
    return true;
  }

  /** Pause for shutdown: progress is saved and the broadcast resumes on next start. */
  async stop() {
    if (!this.#current) return;
    const { controller, done } = this.#current;
    controller.abort(new StopSignal('shutdown'));
    await done;
  }

  #launch(b) {
    const controller = new AbortController();
    const done = this.#run(b, controller.signal)
      .catch((err) => this.logger.error(`Broadcast #${b.id} crashed`, err))
      .finally(() => (this.#current = null));
    this.#current = { b, controller, done };
  }

  async #run(b, signal) {
    const interval = 1000 / this.ratePerSecond;
    const startedAt = Date.now();
    const startedFrom = b.sent + b.failed + b.unreachable;
    let nextSendAt = Date.now();
    let lastStatusAt = 0;
    let failuresInARow = 0;
    let outcome = 'done';
    let error = null;

    try {
      for (const phase of PHASES[b.audience] ?? PHASES.users) {
        const order = PHASES.all;
        if (order.indexOf(phase) < order.indexOf(b.phase)) continue;
        if (phase !== b.phase) {
          b.phase = phase;
          b.cursor_id = null;
        }
        for (;;) {
          const targets = this.store.nextTargets(phase, b.cursor_id);
          if (!targets.length) break;
          for (const chatId of targets) {
            const wait = nextSendAt - Date.now();
            if (wait > 0) await sleep(wait, signal);
            nextSendAt = Math.max(Date.now(), nextSendAt) + interval;

            const result = await this.#deliver(b, phase, chatId, signal);
            if (result === 'source-missing') {
              throw new Error('The message to broadcast was deleted or can\'t be copied.');
            }
            failuresInARow = result === 'failed' ? failuresInARow + 1 : 0;
            if (failuresInARow >= MAX_FAILURES_IN_A_ROW) {
              throw new Error(`Stopped after ${MAX_FAILURES_IN_A_ROW} failed sends in a row (see logs).`);
            }
            b.cursor_id = chatId;
            this.store.saveBroadcastProgress(b); // after every send, so a crash never re-sends

            if (Date.now() - lastStatusAt >= STATUS_EVERY_MS) {
              lastStatusAt = Date.now();
              const done = b.sent + b.failed + b.unreachable;
              const rate = (done - startedFrom) / Math.max(1, (Date.now() - startedAt) / 1000);
              await this.#editStatus(b, texts.broadcastProgress(b, rate), texts.broadcastCancelKeyboard(b.id), signal);
            }
          }
        }
      }
    } catch (err) {
      if (err instanceof StopSignal) outcome = err.message === 'shutdown' ? 'paused' : 'cancelled';
      else {
        outcome = 'failed';
        error = err.message;
      }
    }

    this.store.saveBroadcastProgress(b);
    if (outcome === 'paused') {
      this.logger.info(`Broadcast #${b.id} paused for restart; it will resume automatically`);
      await this.#editStatus(b, texts.broadcastPaused(b));
      return;
    }
    this.store.finishBroadcast(b.id, outcome, error);
    const final = { ...b, status: outcome, error };
    this.logger.info(`Broadcast #${b.id} ${outcome}: ${b.sent} sent, ${b.unreachable} unreachable, ${b.failed} failed`);
    await this.#editStatus(final, texts.broadcastFinished(final));
    // A fresh message so the owner gets a notification.
    if (b.status_chat_id) {
      await this.api
        .sendMessage(b.status_chat_id, texts.broadcastFinishedShort(final), {
          parse_mode: 'HTML',
          reply_parameters: b.status_message_id
            ? { message_id: b.status_message_id, allow_sending_without_reply: true }
            : undefined,
        })
        .catch((err) => this.logger.warn(`Could not notify owner: ${err.message}`));
    }
    this.logChannel.send(texts.broadcastFinishedShort(final));
  }

  async #deliver(b, phase, chatId, signal) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await this.api.copyMessage(chatId, b.from_chat_id, b.message_id, {}, signal);
        b.sent++;
        return 'sent';
      } catch (err) {
        if (signal.aborted) throw signal.reason;
        if (err instanceof GrammyError) {
          if (err.error_code === 429) {
            // Slow down for as long as Telegram asks, then retry the same chat.
            const seconds = err.parameters?.retry_after ?? 5;
            this.logger.warn(`Broadcast #${b.id}: rate limited, pausing ${seconds}s`);
            await sleep(seconds * 1000 + 250, signal);
            continue;
          }
          if (SOURCE_MISSING.test(err.description)) return 'source-missing';
          if (err.error_code === 403 || UNREACHABLE.test(err.description)) {
            if (phase === 'users') this.store.setUserBlocked(chatId);
            else this.store.setChatLeft(chatId);
            b.unreachable++;
            return 'unreachable';
          }
          this.logger.warn(`Broadcast #${b.id}: sending to ${chatId} failed: ${err.description}`);
          b.failed++;
          return 'failed';
        }
        if (err instanceof HttpError && attempt < MAX_ATTEMPTS) {
          await sleep(2000 * attempt, signal); // network hiccup: back off and retry
          continue;
        }
        b.failed++;
        return 'failed';
      }
    }
    b.failed++;
    return 'failed';
  }

  async #editStatus(b, text, replyMarkup, signal) {
    if (!b.status_chat_id || !b.status_message_id) return;
    try {
      await this.api.editMessageText(
        b.status_chat_id,
        b.status_message_id,
        text,
        { parse_mode: 'HTML', reply_markup: replyMarkup },
        signal, // so stopping a broadcast never waits on a status update
      );
    } catch (err) {
      if (!/message is not modified/i.test(err.description ?? '')) {
        this.logger.debug(`Broadcast status update failed: ${err.message}`);
      }
    }
  }
}
