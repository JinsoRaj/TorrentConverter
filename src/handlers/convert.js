import { randomBytes } from 'node:crypto';
import { Composer, GrammyError, InputFile } from 'grammy';
import * as texts from '../texts.js';
import { extractMagnets, InvalidMagnetError, parseMagnet, UnsupportedMagnetError } from '../lib/magnet.js';
import { buildTorrentFile, InvalidTorrentError, summarizeTorrent, UnsupportedTorrentError } from '../lib/torrent.js';
import { MetadataTimeoutError } from '../lib/metadata.js';
import { BusyError, JobLimiter } from '../lib/limiter.js';
import { ResponseTooLargeError } from '../lib/http.js';
import { sanitizeFilename } from '../lib/format.js';

const STATUS_EDIT_INTERVAL_MS = 5_000; // stays well within Telegram's per-chat limits

class CancelledError extends Error {
  name = 'CancelledError';
}
class ShutdownError extends Error {
  name = 'ShutdownError';
}

export function isTorrentDocument(doc) {
  return Boolean(
    doc && (doc.mime_type === 'application/x-bittorrent' || /\.torrent$/i.test(doc.file_name ?? '')),
  );
}

const isPrivate = (ctx) => ctx.chat?.type === 'private';

/**
 * Who a job belongs to (for per-user limits and the Cancel button). Anonymous
 * group admins and people posting as a channel all share one Telegram user id,
 * so those are keyed by the chat they post as instead.
 */
const requesterKey = (ctx) => (ctx.msg?.sender_chat ? `chat:${ctx.msg.sender_chat.id}` : `user:${ctx.from?.id ?? ctx.chat?.id}`);

/** Reply to the triggering message, still working if it was deleted meanwhile. */
const replyOptions = (ctx, extra = {}) => ({
  parse_mode: 'HTML',
  link_preview_options: { is_disabled: true },
  reply_parameters: { message_id: ctx.msg.message_id, allow_sending_without_reply: true },
  ...extra,
});

const isIgnorableEditError = (err) =>
  err instanceof GrammyError && /message is not modified|message to edit not found|message can't be edited/i.test(err.description);

/**
 * Edits a status message at most every few seconds. `stop()` cancels anything
 * in flight so a late progress update can never overwrite the final result.
 */
function createStatusEditor(ctx, message, replyMarkup) {
  const abort = new AbortController();
  let lastText = null;
  let pendingText = null;
  let lastEditAt = Date.now();
  let timer = null;
  let inFlight = null;

  const flush = async () => {
    timer = null;
    if (abort.signal.aborted || pendingText === null || inFlight) return;
    const text = pendingText;
    pendingText = null;
    lastEditAt = Date.now();
    inFlight = ctx.api
      .editMessageText(message.chat.id, message.message_id, text, { parse_mode: 'HTML', reply_markup: replyMarkup }, abort.signal)
      .then(() => (lastText = text))
      .catch(() => {}) // progress updates are best-effort
      .finally(() => {
        inFlight = null;
        if (pendingText !== null) schedule();
      });
  };
  const schedule = () => {
    if (timer || abort.signal.aborted) return;
    timer = setTimeout(flush, Math.max(0, lastEditAt + STATUS_EDIT_INTERVAL_MS - Date.now()));
  };
  return {
    update(text, { immediate = false } = {}) {
      if (abort.signal.aborted || text === lastText) return;
      pendingText = text;
      if (immediate) {
        clearTimeout(timer);
        timer = null;
        lastEditAt = 0;
      }
      schedule();
    },
    async stop() {
      clearTimeout(timer);
      abort.abort();
      await inFlight;
    },
  };
}

/**
 * Conversion handlers (magnet → torrent and torrent → magnet).
 * @param {object} deps
 */
export function createConverter({ config, fetcher, limiter, stats, logger, downloadFile }) {
  const composer = new Composer();
  /** @type {Map<string, {owner: string, controller: AbortController}>} */
  const jobs = new Map();
  // Reading .torrent files is quick but can briefly hold up to 20 MB each: run a few at a time.
  const parseLimiter = new JobLimiter({ concurrency: 2, perUser: Infinity, maxQueue: 100 });
  let shuttingDown = false;
  const timeoutSeconds = Math.round(config.metadataTimeoutMs / 1000);

  const safely = async (what, fn) => {
    try {
      return await fn();
    } catch (err) {
      if (!isIgnorableEditError(err)) logger.warn(`Could not ${what}: ${err.message}`);
      return undefined;
    }
  };

  // ── Magnet → torrent ──────────────────────────────────────────────────

  async function convertMagnet(ctx, uri) {
    let magnet;
    try {
      magnet = await parseMagnet(uri);
    } catch (err) {
      if (err instanceof UnsupportedMagnetError) return ctx.reply(texts.v2Unsupported(), replyOptions(ctx));
      if (err instanceof InvalidMagnetError) return ctx.reply(texts.invalidMagnet(), replyOptions(ctx));
      throw err;
    }

    const userId = requesterKey(ctx);
    if (shuttingDown) return ctx.reply(texts.shuttingDown(), replyOptions(ctx));
    if (!limiter.acquireUser(userId)) return ctx.reply(texts.tooManyJobs(limiter.perUser), replyOptions(ctx));

    const jobId = randomBytes(6).toString('base64url');
    const controller = new AbortController();
    jobs.set(jobId, { owner: userId, controller });
    const startedAt = Date.now();
    let status;
    let editor;
    try {
      const cancelKeyboard = texts.cancelKeyboard(jobId);
      status = await ctx.reply(texts.searching(magnet, {}, timeoutSeconds), replyOptions(ctx, { reply_markup: cancelKeyboard }));
      editor = createStatusEditor(ctx, status, cancelKeyboard);

      const { info, cached } = await limiter.run(
        () =>
          fetcher.fetch(magnet, {
            timeoutMs: config.metadataTimeoutMs,
            signal: controller.signal,
            onProgress: (progress) => editor.update(texts.searching(magnet, progress, timeoutSeconds)),
          }),
        {
          signal: controller.signal,
          onQueued: (position) => editor.update(texts.queued(magnet, position), { immediate: true }),
        },
      );
      await editor.stop();

      const torrent = buildTorrentFile(info, magnet);
      const summary = await summarizeTorrent(torrent);
      const elapsedMs = Date.now() - startedAt;
      await safely('send chat action', () => ctx.replyWithChatAction('upload_document'));
      await ctx.replyWithDocument(
        new InputFile(torrent, `${sanitizeFilename(summary.name, magnet.infoHash)}.torrent`),
        replyOptions(ctx, { caption: texts.torrentCaption(summary, { cached, elapsedMs }) }),
      );
      await safely('delete status message', () => ctx.api.deleteMessage(status.chat.id, status.message_id));
      stats.record('magnet', true);
      logger.info(`magnet→torrent ${magnet.infoHash} ok in ${elapsedMs}ms${cached ? ' (cached)' : ''}`);
    } catch (err) {
      await editor?.stop();
      stats.record('magnet', false);
      let text;
      if (err instanceof CancelledError) text = texts.cancelled();
      else if (err instanceof ShutdownError) text = texts.shuttingDown();
      else if (err instanceof MetadataTimeoutError) text = texts.fetchTimeout(err.stats, timeoutSeconds);
      else if (err instanceof BusyError) text = texts.busy();
      else {
        logger.error(`magnet→torrent ${magnet.infoHash} failed`, err);
        text = texts.unexpectedError();
      }
      if (status) {
        await safely('update status message', () =>
          ctx.api.editMessageText(status.chat.id, status.message_id, text, { parse_mode: 'HTML' }),
        );
      } else {
        await safely('send error message', () => ctx.reply(text, replyOptions(ctx)));
      }
    } finally {
      jobs.delete(jobId);
      limiter.releaseUser(userId);
    }
  }

  async function handleMagnets(ctx, uris) {
    const max = config.maxMagnetsPerMessage;
    if (uris.length > max) await ctx.reply(texts.tooManyMagnets(max), replyOptions(ctx));
    // One at a time, so a single message can't take over every slot.
    for (const uri of uris.slice(0, max)) await convertMagnet(ctx, uri);
  }

  // ── Torrent → magnet ──────────────────────────────────────────────────

  async function handleTorrentDocument(ctx, doc) {
    if (doc.file_size && doc.file_size > config.maxTorrentBytes) {
      return ctx.reply(texts.fileTooLarge(), replyOptions(ctx));
    }
    const userId = requesterKey(ctx);
    if (!limiter.acquireUser(userId)) return ctx.reply(texts.tooManyJobs(limiter.perUser), replyOptions(ctx));
    try {
      await safely('send chat action', () => ctx.replyWithChatAction('typing'));
      let summary;
      try {
        summary = await parseLimiter.run(async () => {
          const file = await ctx.api.getFile(doc.file_id);
          if (!file.file_path) throw new Error('Telegram returned no file path');
          return summarizeTorrent(await downloadFile(file.file_path, config.maxTorrentBytes));
        });
      } catch (err) {
        stats.record('torrent', false);
        let text;
        if (err instanceof InvalidTorrentError) text = texts.invalidTorrent();
        else if (err instanceof UnsupportedTorrentError) text = texts.v2Unsupported();
        else if (err instanceof BusyError) text = texts.busy();
        else if (err instanceof ResponseTooLargeError || /file is too big/i.test(err.description ?? '')) {
          text = texts.fileTooLarge();
        } else {
          logger.warn(`torrent download/parse failed: ${err.message}`);
          text = texts.downloadFailed();
        }
        return ctx.reply(text, replyOptions(ctx));
      }

      const { text, keyboard, attachFullMagnet } = texts.magnetResult(summary);
      await ctx.reply(text, replyOptions(ctx, { reply_markup: keyboard }));
      if (attachFullMagnet) {
        await ctx.replyWithDocument(
          new InputFile(Buffer.from(summary.magnet), `${sanitizeFilename(summary.name, summary.infoHash)}.magnet.txt`),
          replyOptions(ctx),
        );
      }
      stats.record('torrent', true);
      logger.info(`torrent→magnet ${summary.infoHash} ok`);
    } finally {
      limiter.releaseUser(userId);
    }
  }

  // ── Routing ───────────────────────────────────────────────────────────

  composer.callbackQuery(/^cancel:([\w-]+)$/, async (ctx) => {
    const job = jobs.get(ctx.match[1]);
    if (!job) return ctx.answerCallbackQuery({ text: 'This conversion has already finished.' });
    // Jobs started anonymously (as a channel / anonymous admin) can be cancelled by anyone in the chat.
    if (!job.owner.startsWith('chat:') && job.owner !== `user:${ctx.from.id}`) {
      return ctx.answerCallbackQuery({ text: 'Only the person who sent the link can cancel it.' });
    }
    job.controller.abort(new CancelledError('Cancelled by user'));
    return ctx.answerCallbackQuery({ text: 'Cancelled' });
  });

  // /convert <magnet>, or /convert as a reply to a magnet link / .torrent file.
  composer.command('convert', async (ctx) => {
    const max = config.maxMagnetsPerMessage;
    let magnets = extractMagnets(ctx.match, max + 1);
    const target = ctx.msg.reply_to_message;
    if (!magnets.length && target) magnets = extractMagnets(target.text ?? target.caption, max + 1);
    if (magnets.length) return handleMagnets(ctx, magnets);
    if (isTorrentDocument(target?.document)) return handleTorrentDocument(ctx, target.document);
    return ctx.reply(texts.convertUsage(), replyOptions(ctx));
  });

  // .torrent files. Other documents fall through (their captions may hold magnets).
  composer.on('message:document', async (ctx, next) => {
    if (!isTorrentDocument(ctx.msg.document)) return next();
    return handleTorrentDocument(ctx, ctx.msg.document);
  });

  composer.on(['message:text', 'message:caption'], async (ctx, next) => {
    const text = ctx.msg.text ?? ctx.msg.caption;
    const entity = (ctx.msg.entities ?? ctx.msg.caption_entities ?? [])[0];

    // v1 compatibility: "/anycommand magnet:?…" (but never commands meant for another bot).
    if (entity?.type === 'bot_command' && entity.offset === 0) {
      const command = text.slice(1, entity.length);
      const at = command.indexOf('@');
      if (at !== -1 && command.slice(at + 1).toLowerCase() !== ctx.me.username.toLowerCase()) return next();
      const args = text.slice(entity.length).trimStart();
      if (!/^magnet:\?/i.test(args)) return next();
      return handleMagnets(ctx, extractMagnets(args, config.maxMagnetsPerMessage + 1));
    }

    // Private chats: magnets anywhere in the message. Groups: only messages that
    // start with a magnet, so normal conversation isn't hijacked.
    if (!isPrivate(ctx) && !/^magnet:\?/i.test(text.trimStart())) return next();
    const magnets = extractMagnets(text, config.maxMagnetsPerMessage + 1);
    if (!magnets.length) return next();
    return handleMagnets(ctx, magnets);
  });

  return {
    composer,
    get activeJobs() {
      return jobs.size;
    },
    /** Abort everything in flight (used on shutdown). */
    abortAll() {
      shuttingDown = true;
      for (const job of jobs.values()) job.controller.abort(new ShutdownError('Shutting down'));
    },
  };
}
