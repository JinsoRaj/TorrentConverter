import { createHash } from 'node:crypto';
import bencode from 'bencode';
import { createBot, createStats } from '../src/bot.js';
import { JobLimiter } from '../src/lib/limiter.js';
import { silentLogger } from '../src/logger.js';

export const sha1 = (bytes) => createHash('sha1').update(bytes).digest('hex');

/** A small but valid single-file torrent. */
export function makeTorrent({ name = 'Test File.txt', length = 123_456, announce = [], isPrivate = false } = {}) {
  const info = { length, name, 'piece length': 16384, pieces: Buffer.alloc(20 * Math.ceil(length / 16384), 7) };
  if (isPrivate) info.private = 1;
  const rawInfo = Buffer.from(bencode.encode(info));
  const torrent = { info };
  if (announce.length) {
    torrent.announce = announce[0];
    torrent['announce-list'] = announce.map((a) => [a]);
  }
  return { torrent: Buffer.from(bencode.encode(torrent)), rawInfo, infoHash: sha1(rawInfo) };
}

export const BOT_INFO = {
  id: 1000,
  is_bot: true,
  first_name: 'Torrent Converter',
  username: 'TestConverterBot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
};

export const USER = { id: 7, is_bot: false, first_name: 'Ann' };
export const OTHER_USER = { id: 8, is_bot: false, first_name: 'Bob' };
export const PRIVATE_CHAT = { id: 7, type: 'private', first_name: 'Ann' };
export const GROUP_CHAT = { id: -100123, type: 'supergroup', title: 'Leech group' };

export const baseConfig = {
  botToken: '123456:TEST-TOKEN-TEST-TOKEN-TEST',
  ownerId: 99,
  metadataTimeoutMs: 60_000,
  maxConcurrentJobs: 5,
  maxJobsPerUser: 2,
  maxMagnetsPerMessage: 5,
  maxTorrentBytes: 20 * 1024 * 1024,
};

/**
 * A bot wired to a fake Telegram API that records every call.
 */
export function createHarness({ fetcher, downloadFile, config = {}, store, respond } = {}) {
  const calls = [];
  let nextMessageId = 500;
  let updateId = 1;
  const fullConfig = { ...baseConfig, ...config };
  const limiter = new JobLimiter({ concurrency: fullConfig.maxConcurrentJobs, perUser: fullConfig.maxJobsPerUser });
  const stats = createStats();
  const { bot, converter, logChannel, broadcaster } = createBot({
    config: fullConfig,
    fetcher: fetcher ?? { fetch: async () => { throw new Error('no fetcher'); }, stats: { dhtNodes: 0, cachedTorrents: 0 } },
    limiter,
    stats,
    logger: silentLogger,
    downloadFile: downloadFile ?? (async () => { throw new Error('no downloader'); }),
    store,
    botInfo: BOT_INFO,
  });

  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload });
    const custom = await respond?.(method, payload);
    if (custom) return custom;
    const chat = { id: payload.chat_id, type: payload.chat_id > 0 ? 'private' : 'supergroup' };
    switch (method) {
      case 'sendMessage':
        return { ok: true, result: { message_id: nextMessageId++, date: 0, chat, text: payload.text } };
      case 'sendDocument':
        return { ok: true, result: { message_id: nextMessageId++, date: 0, chat, document: { file_id: 'x', file_unique_id: 'y' } } };
      case 'copyMessage':
        return { ok: true, result: { message_id: nextMessageId++ } };
      case 'getFile':
        return { ok: true, result: { file_id: payload.file_id, file_unique_id: 'u', file_path: 'documents/file_1.torrent' } };
      default:
        return { ok: true, result: true };
    }
  });

  const commandEntities = (text) => {
    const m = /^\/\S+/.exec(text);
    return m ? [{ type: 'bot_command', offset: 0, length: m[0].length }] : undefined;
  };

  return {
    bot,
    converter,
    logChannel,
    broadcaster,
    calls,
    stats,
    limiter,
    /** Calls to a given API method. */
    sent: (method) => calls.filter((c) => c.method === method),
    clear: () => (calls.length = 0),
    text(text, { chat = PRIVATE_CHAT, from = USER, reply_to_message } = {}) {
      return bot.handleUpdate({
        update_id: updateId++,
        message: { message_id: updateId, date: 0, chat, from, text, entities: commandEntities(text), reply_to_message },
      });
    },
    document(document, { chat = PRIVATE_CHAT, from = USER, caption } = {}) {
      return bot.handleUpdate({
        update_id: updateId++,
        message: { message_id: updateId, date: 0, chat, from, document, caption },
      });
    },
    myChatMember({ chat, from = USER, before, after }) {
      return bot.handleUpdate({
        update_id: updateId++,
        my_chat_member: {
          chat,
          from,
          date: 0,
          old_chat_member: { status: before, user: BOT_INFO },
          new_chat_member: { status: after, user: BOT_INFO },
        },
      });
    },
    callback(data, { from = USER, chat = PRIVATE_CHAT, messageId = 1 } = {}) {
      return bot.handleUpdate({
        update_id: updateId++,
        callback_query: {
          id: String(updateId),
          from,
          chat_instance: '1',
          data,
          message: { message_id: messageId, date: 0, chat, text: 'menu' },
        },
      });
    },
  };
}

export const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until `predicate()` is true (polling), or fail after `timeoutMs`. */
export async function waitFor(predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await tick(5);
  }
}
