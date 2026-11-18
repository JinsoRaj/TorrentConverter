import { Bot, GrammyError, HttpError } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { createAdmin } from './handlers/admin.js';
import { createCommands, createFallback } from './handlers/commands.js';
import { createConverter } from './handlers/convert.js';
import { createTracker } from './handlers/tracking.js';
import { Broadcaster } from './broadcast.js';
import { readBodyCapped } from './lib/http.js';
import { LogChannel } from './lib/log-channel.js';
import * as texts from './texts.js';

export const ALLOWED_UPDATES = ['message', 'callback_query', 'my_chat_member'];

export function createStats() {
  const counters = { magnet: { ok: 0, failed: 0 }, torrent: { ok: 0, failed: 0 } };
  return {
    startedAt: Date.now(),
    counters,
    record(kind, ok) {
      counters[kind][ok ? 'ok' : 'failed']++;
    },
  };
}

/** Downloads a file from Telegram. Errors never include the URL (it contains the token). */
export function createTelegramDownloader(token, { timeoutMs = 30_000 } = {}) {
  return async (filePath, maxBytes) => {
    let res;
    try {
      res = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // The original error is dropped on purpose: never risk the token-bearing URL reaching logs.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(`Could not download file from Telegram (${err.cause?.code ?? err.name})`);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`Telegram file download failed with HTTP ${res.status}`);
    }
    return readBodyCapped(res, maxBytes);
  };
}

/**
 * Wire up the bot. Dependencies are injected so the whole thing can be tested
 * without talking to Telegram or the BitTorrent network.
 * Without a `store` (database) there is no user tracking and no /broadcast.
 */
export function createBot({ config, fetcher, limiter, stats, logger, downloadFile, store, botInfo, client }) {
  const bot = new Bot(config.botToken, { botInfo, client });
  // Transparently wait out rate limits (429) and retry transient server errors.
  // Network errors are rethrown (not retried forever): polling has its own retry
  // loop, and everything else should fail fast and be reported.
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60, rethrowHttpErrors: true }));

  const logChannel = new LogChannel({ api: bot.api, chatId: config.logChatId, logger, intervalMs: config.logIntervalMs });
  const broadcaster = store
    ? new Broadcaster({ api: bot.api, store, logger, logChannel, ratePerSecond: config.broadcastRate ?? 20 })
    : undefined;

  const converter = createConverter({ config, fetcher, limiter, stats, logger, downloadFile });
  if (store) bot.use(createTracker({ store, logChannel, logger }));
  bot.use(createAdmin({ config, stats, limiter, fetcher, store, broadcaster }));
  bot.use(createCommands({ config }));
  bot.use(converter.composer);
  bot.use(createFallback());

  bot.catch(({ ctx, error }) => {
    const where = `update ${ctx?.update?.update_id}`;
    if (error instanceof GrammyError) {
      // e.g. the bot was blocked or can't write in a group: nothing to fix, just log it.
      logger.warn(`Telegram API error while handling ${where}: ${error.description}`);
    } else if (error instanceof HttpError) {
      logger.warn(`Network error talking to Telegram while handling ${where}: ${error.message}`);
    } else {
      logger.error(`Unexpected error while handling ${where}`, error);
      logChannel.send(texts.logError(where, error));
    }
  });

  return { bot, converter, logChannel, broadcaster };
}
