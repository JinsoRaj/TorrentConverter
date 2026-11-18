// Every user-facing message lives here (Telegram HTML parse mode).
// Anything that comes from users or torrents MUST go through `h()`.

import { InlineKeyboard } from 'grammy';
import { escapeHtml as h, formatBytes, formatDuration, plural, truncate } from './lib/format.js';
import { buildMagnet } from './lib/torrent.js';
import { APP_VERSION, REPO_URL } from './version.js';

export const DEVELOPER_USERNAME = 'WideWine';
const COPY_TEXT_LIMIT = 256; // Bot API limit for copy_text buttons
const MAX_MAGNET_IN_MESSAGE = 3500;
const MAX_MESSAGE_LENGTH = 4000; // Telegram's limit is 4096

const nameLine = (name) => `<b>${h(truncate(name, 200))}</b>`;
const sizeLine = (t) => `💾 ${formatBytes(t.length)} · 📁 ${plural(t.fileCount, 'file')}`;

// ─── Menus ─────────────────────────────────────────────────────────────────

export function welcome(user) {
  const name = user?.first_name ? ` <b>${h(truncate(user.first_name, 64))}</b>` : '';
  return [
    `👋 Hi${name}!`,
    '',
    'I convert <b>magnet links ⇄ .torrent files</b>.',
    '',
    '🧲 Send a <b>magnet link</b> → get the <b>.torrent</b> file',
    '📄 Send a <b>.torrent file</b> → get its <b>magnet link</b>',
    '',
    'I work in groups too. Tap <b>How to use</b> for details.',
  ].join('\n');
}

export function startKeyboard(botUsername) {
  return new InlineKeyboard()
    .text('📖 How to use', 'menu:help')
    .text('ℹ️ About', 'menu:about')
    .row()
    .url('➕ Add me to a group', `https://t.me/${botUsername}?startgroup=start`)
    .row()
    .url('🧑‍💻 Developer', `https://t.me/${DEVELOPER_USERNAME}`)
    .url('🌟 Source code', REPO_URL);
}

export const backKeyboard = () => new InlineKeyboard().text('« Back', 'menu:start');

export function help({ timeoutSeconds, maxMagnets }) {
  return [
    '<b>📖 How to use</b>',
    '',
    '<b>🧲 Magnet → Torrent</b>',
    `Send me a magnet link. I find peers on the BitTorrent network, download the torrent's metadata and send you the .torrent file. This usually takes a few seconds (at most ${timeoutSeconds}s).`,
    '',
    '<b>📄 Torrent → Magnet</b>',
    'Send me a .torrent file (up to 20 MB) and I reply with its magnet link and details. Tap the link to copy it.',
    '',
    '<b>👥 In groups</b>',
    '• Messages that start with a magnet link are converted automatically.',
    '• Or send <code>/convert magnet:?…</code>',
    '• Or reply to a magnet link or .torrent file with /convert',
    'If I\'m not an admin, I may only see commands, so use /convert.',
    '',
    '<b>💡 Good to know</b>',
    '• Magnet → torrent only works while someone is sharing the torrent. Dead torrents can\'t be converted.',
    `• You can send up to ${maxMagnets} magnet links in one message.`,
  ].join('\n');
}

export function about() {
  return [
    `<b>🔄 Torrent Converter</b> v${h(APP_VERSION)}`,
    '',
    `🧑‍💻 Developer: @${DEVELOPER_USERNAME}`,
    '⚙️ Framework: <a href="https://grammy.dev">grammY</a> 💙',
    `📦 Source code: <a href="${h(REPO_URL)}">GitHub</a> (MIT license)`,
  ].join('\n');
}

export function aboutKeyboard(botUsername, { withBack = false } = {}) {
  const keyboard = new InlineKeyboard()
    .url('🌟 Rate me', `https://t.me/tlgrmcbot?start=${botUsername.toLowerCase()}-review`)
    .url('📦 Source code', REPO_URL);
  if (withBack) keyboard.row().text('« Back', 'menu:start');
  return keyboard;
}

export const addedToGroup = () =>
  [
    '👋 Thanks for adding me!',
    '',
    'Send a magnet link or a .torrent file and I\'ll convert it. If I can\'t see regular messages here, use <code>/convert magnet:?…</code> or reply to a file with /convert.',
    '',
    'See /help for details.',
  ].join('\n');

// ─── Magnet → torrent ─────────────────────────────────────────────────────

const label = (magnet) => (magnet.name ? nameLine(magnet.name) : `<code>${magnet.infoHash}</code>`);

export function searching(magnet, { elapsedMs = 0, peers = 0, connected = 0 } = {}, timeoutSeconds) {
  return [
    '🔎 <b>Fetching torrent metadata…</b>',
    label(magnet),
    '',
    `⏱ ${Math.round(elapsedMs / 1000)}s / ${timeoutSeconds}s · 👥 ${peers} peers · 🔗 ${connected} connected`,
  ].join('\n');
}

export const queued = (magnet, position) =>
  ['⏳ <b>Waiting in queue…</b>', label(magnet), '', `Position: ${position}. Lots of people are converting right now.`].join(
    '\n',
  );

export const cancelKeyboard = (jobId) => new InlineKeyboard().text('✖️ Cancel', `cancel:${jobId}`);

export function torrentCaption(t, { cached = false, elapsedMs } = {}) {
  const lines = ['✅ ' + nameLine(t.name), sizeLine(t), `🔑 <code>${t.infoHash}</code>`];
  if (t.private) lines.push('🔒 Private torrent');
  if (!cached && elapsedMs !== undefined) lines.push(`<i>Fetched in ${(elapsedMs / 1000).toFixed(1)}s</i>`);
  return lines.join('\n');
}

export function fetchTimeout(stats, timeoutSeconds) {
  const why =
    stats?.peers > 0
      ? `I found ${plural(stats.peers, 'peer')}, but none of them sent the metadata within ${timeoutSeconds}s.`
      : `I couldn't find anyone sharing this torrent within ${timeoutSeconds}s.`;
  return ['😕 <b>Couldn\'t get this torrent.</b>', why, '', 'It may be dead or have very few seeders. Try again later.'].join(
    '\n',
  );
}

// ─── Torrent → magnet ─────────────────────────────────────────────────────

/** Builds the reply for a parsed .torrent; very long magnets are attached as a file. */
export function magnetResult(t) {
  const lines = [
    '🧲 <b>Magnet link</b>',
    '',
    '📄 ' + nameLine(t.name),
    `${sizeLine(t)} · 📡 ${plural(t.announce.length, 'tracker')}`,
    `🔑 <code>${t.infoHash}</code>`,
  ];
  if (t.private) lines.push('🔒 Private torrent: the magnet only works with its tracker.');

  const shortMagnet = buildMagnet({ ...t, name: truncate(t.name, 100) }, { trackers: false });
  const build = (magnet, note) => [...lines, '', `<code>${h(magnet)}</code>`, '', note].join('\n');
  let text = build(t.magnet, '<i>Tap the link to copy it.</i>');
  // Telegram counts the text *without* HTML tags; measuring the HTML is a safe over-estimate.
  const tooLong = t.magnet.length > MAX_MAGNET_IN_MESSAGE || text.length > MAX_MESSAGE_LENGTH;
  if (tooLong) {
    text = build(
      shortMagnet,
      '<i>The full magnet link is too long for a message, so it\'s attached as a file. The link above has no trackers.</i>',
    );
  }

  const keyboard = new InlineKeyboard();
  if (t.magnet.length <= COPY_TEXT_LIMIT) keyboard.copyText('📋 Copy magnet link', t.magnet);
  else if (shortMagnet.length <= COPY_TEXT_LIMIT) keyboard.copyText('📋 Copy short magnet (no trackers)', shortMagnet);

  return { text, keyboard, attachFullMagnet: tooLong };
}

// ─── Errors & hints ───────────────────────────────────────────────────────

export const invalidMagnet = () =>
  '❌ That doesn\'t look like a valid magnet link.\nIt should start with <code>magnet:?xt=urn:btih:</code>';
export const v2Unsupported = () => '⚠️ BitTorrent v2-only torrents and magnets aren\'t supported yet.';
export const invalidTorrent = () => '❌ This file isn\'t a valid .torrent file.';
export const notATorrent = () => '📄 Please send a <b>.torrent</b> file. This one doesn\'t look like a torrent.';
export const fileTooLarge = () => '❌ This file is too big. Telegram only lets bots download files up to 20 MB.';
export const downloadFailed = () => '⚠️ I couldn\'t download that file from Telegram. Please try again.';
export const tooManyJobs = (limit) =>
  `⏳ You already have ${plural(limit, 'conversion')} running. Please wait for ${limit === 1 ? 'it' : 'them'} to finish.`;
export const tooManyMagnets = (max) => `ℹ️ I'll convert the first ${max} magnet links from your message.`;
export const busy = () => '🚦 I\'m very busy right now. Please try again in a minute.';
export const cancelled = () => '✖️ Cancelled.';
export const shuttingDown = () => '🔄 I\'m restarting. Please send your link again in a minute.';
export const unexpectedError = () => '⚠️ Something went wrong. Please try again.';
export const privateHint = () =>
  'Send me a <b>magnet link</b> or a <b>.torrent file</b> and I\'ll convert it.\nSee /help for details.';
export const unknownCommand = () => 'I don\'t know that command. Try /help.';
export const convertUsage = () =>
  'Send <code>/convert magnet:?…</code>, or reply to a message that has a magnet link or a .torrent file with /convert.';

// ─── Owner ────────────────────────────────────────────────────────────────

const n = (value) => Number(value ?? 0).toLocaleString('en-US');

export function stats({ startedAt, counters, limiter, fetcher, db, broadcast, memory, username }) {
  const row = (name, c) => `${name}: ✅ ${n(c.ok)} · ❌ ${n(c.failed)}`;
  const lines = [`<b>📊 @${h(username)} stats</b>`, ''];
  if (db) {
    lines.push(
      `👤 Users: ${n(db.users)} (${n(db.activeUsers)} reachable)`,
      `🆕 New today: ${n(db.newUsers24h)} · active today: ${n(db.activeUsers24h)}`,
      `👥 Groups: ${n(db.activeChats)} (${n(db.chats)} ever)`,
      '',
    );
  }
  lines.push(
    `<b>Since start</b> (${formatDuration(Date.now() - startedAt)} ago)`,
    row('Magnet → torrent', counters.magnet),
    row('Torrent → magnet', counters.torrent),
    '',
    `Jobs: ${limiter.active} running · ${limiter.queued} queued`,
    `DHT nodes: ${n(fetcher.dhtNodes)} · cached torrents: ${n(fetcher.cachedTorrents)}`,
    `Memory: ${formatBytes(memory.rss)} RSS`,
    `Version: v${h(APP_VERSION)} · Node ${h(process.version)}`,
  );
  if (broadcast) lines.push('', `📣 Broadcast #${broadcast.id} is running.`);
  return lines.join('\n');
}

// ─── Broadcast (owner) ────────────────────────────────────────────────────

const eta = (count, rate) => formatDuration((count / Math.max(rate, 0.1)) * 1000);

export const broadcastUsage = () =>
  [
    '<b>📣 Broadcast</b>',
    '',
    'Send me the message you want to broadcast (text, photo, video, anything, with formatting), then <b>reply to it</b> with /broadcast.',
    '',
    'It\'s copied to every user who has used the bot (and optionally to groups), at a safe speed that stays within Telegram\'s limits. Don\'t delete the message until the broadcast finishes.',
  ].join('\n');

export const broadcastBusy = (b) =>
  `📣 Broadcast #${b.id} is still running (${n(b.sent + b.failed + b.unreachable)}/${n(b.total)}). Cancel it or wait for it to finish.`;

export function broadcastConfirm(counts, rate) {
  return [
    '<b>📣 Broadcast this message?</b>',
    '',
    `👤 ${n(counts.activeUsers)} users`,
    `👥 ${n(counts.activeChats)} groups`,
    '',
    `Sending at about ${rate} messages/second: ~${eta(counts.activeUsers, rate)} for users only, ~${eta(counts.activeUsers + counts.activeChats, rate)} with groups.`,
  ].join('\n');
}

export const broadcastConfirmKeyboard = (messageId, counts) =>
  new InlineKeyboard()
    .text(`👤 Users only (${n(counts.activeUsers)})`, `bc:go:users:${messageId}`)
    .row()
    .text(`👥 Users + groups (${n(counts.activeUsers + counts.activeChats)})`, `bc:go:all:${messageId}`)
    .row()
    .text('✖️ Cancel', 'bc:no');

export const broadcastCancelKeyboard = (id) => new InlineKeyboard().text('✖️ Stop broadcast', `bc:cancel:${id}`);
export const broadcastDiscarded = () => '✖️ Broadcast discarded.';

function progressBar(fraction, width = 12) {
  const filled = Math.round(Math.min(1, Math.max(0, fraction)) * width);
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

const counters = (b) => `✅ ${n(b.sent)} sent · 🚫 ${n(b.unreachable)} unreachable · ❌ ${n(b.failed)} failed`;

export function broadcastProgress(b, rate) {
  const done = b.sent + b.failed + b.unreachable;
  const fraction = b.total ? done / b.total : 0;
  const lines = [
    `<b>📣 Broadcast #${b.id}</b> (${b.audience === 'all' ? 'users + groups' : 'users'})`,
    '',
    `${progressBar(fraction)} ${Math.floor(fraction * 100)}%`,
    `${n(done)} / ${n(b.total)}`,
    counters(b),
  ];
  if (rate > 0 && done < b.total) lines.push(`⏱ ~${eta(b.total - done, rate)} left`);
  return lines.join('\n');
}

export const broadcastPaused = (b) =>
  `${broadcastProgress(b, 0)}\n\n⏸ <i>Paused for a bot restart. It will continue automatically.</i>`;

const FINISHED = {
  done: '✅ finished',
  cancelled: '✖️ stopped',
  failed: '⚠️ failed',
};

export function broadcastFinished(b) {
  const lines = [`<b>📣 Broadcast #${b.id} ${FINISHED[b.status] ?? b.status}</b>`, '', counters(b)];
  if (b.error) lines.push('', `⚠️ ${h(b.error)}`);
  if (b.unreachable) lines.push('', '<i>Unreachable users (blocked the bot or deleted their account) are skipped from now on.</i>');
  return lines.join('\n');
}

export const broadcastFinishedShort = (b) =>
  `📣 #Broadcast #${b.id} ${FINISHED[b.status] ?? b.status}: ${counters(b)}${b.error ? `\n⚠️ ${h(b.error)}` : ''}`;

export const logBroadcastStarted = (b) =>
  `📣 #Broadcast #${b.id} started → ${n(b.total)} ${b.audience === 'all' ? 'users + groups' : 'users'}`;

// ─── Log channel ──────────────────────────────────────────────────────────

const userLink = (u) => `<a href="tg://user?id=${u.id}">${h(truncate(u.first_name || 'User', 64))}</a>`;
const handle = (x) => (x?.username ? ` @${h(x.username)}` : '');

export const logNewUser = (u) =>
  `👤 #NewUser ${userLink(u)}${handle(u)}\n🆔 <code>${u.id}</code>${u.language_code ? ` · 🌐 ${h(u.language_code)}` : ''}`;

export const logAddedToGroup = (chat, by) =>
  `👥 #NewGroup <b>${h(truncate(chat.title ?? 'Untitled', 100))}</b>${handle(chat)}\n🆔 <code>${chat.id}</code> · added by ${userLink(by)}`;

export const logRemovedFromGroup = (chat, by) =>
  `👋 #LeftGroup <b>${h(truncate(chat.title ?? 'Untitled', 100))}</b>\n🆔 <code>${chat.id}</code> · removed by ${userLink(by)}`;

export const logStarted = (username, db) =>
  `🟢 #Started @${h(username)} v${h(APP_VERSION)} · Node ${h(process.version)}${db ? ` · ${n(db.activeUsers)} users · ${n(db.activeChats)} groups` : ''}`;

export function logError(where, error) {
  // Escaping can grow text up to 6x, so shrink until the escaped form fits.
  let detail = truncate(error?.stack ?? String(error), 1500);
  while (h(detail).length > 3000) detail = truncate(detail, Math.floor(Array.from(detail).length * 0.7));
  return `⚠️ #Error while handling ${h(where)}\n<code>${h(detail)}</code>`;
}
