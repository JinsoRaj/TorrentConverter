// End-to-end tests of the bot's behaviour against a fake Telegram API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import parseTorrent from 'parse-torrent';
import { MetadataTimeoutError } from '../src/lib/metadata.js';
import { Store } from '../src/lib/db.js';
import {
  BOT_INFO,
  createHarness,
  GROUP_CHAT,
  makeTorrent,
  OTHER_USER,
  PRIVATE_CHAT,
  tick,
  USER,
  waitFor,
} from './helpers.js';

const seeded = makeTorrent({ name: 'Ubuntu <Server>.iso', length: 4_080_486_400 });
const MAGNET = `magnet:?xt=urn:btih:${seeded.infoHash}&dn=Ubuntu&tr=udp%3A%2F%2Ftracker.example%3A1337%2Fannounce`;
const fakeFetcher = (impl) => ({
  fetch: impl ?? (async () => ({ info: seeded.rawInfo, cached: false })),
  stats: { dhtNodes: 12, cachedTorrents: 3, activeLookups: 0 },
});
const torrentDoc = { file_id: 'f1', file_unique_id: 'u1', file_name: 'file.torrent', mime_type: 'application/x-bittorrent', file_size: 500 };
const buttons = (call) => call.payload.reply_markup?.inline_keyboard?.flat() ?? [];
const OWNER = { id: 99, is_bot: false, first_name: 'Owner' };
const OWNER_CHAT = { id: 99, type: 'private', first_name: 'Owner' };

test('/start greets the user (HTML-escaped) with a menu', async () => {
  const h = createHarness();
  await h.text('/start', { from: { ...USER, first_name: '<b>Eve</b> & co' } });
  const [msg] = h.sent('sendMessage');
  assert.match(msg.payload.text, /Hi <b>&lt;b&gt;Eve&lt;\/b&gt; &amp; co<\/b>!/);
  const urls = buttons(msg).map((b) => b.url).filter(Boolean);
  assert.ok(urls.includes(`https://t.me/${BOT_INFO.username}?startgroup=start`));
  assert.ok(urls.includes('https://github.com/JinsoRaj/TorrentConverter'));
});

test('menu buttons edit the message in place', async () => {
  const h = createHarness();
  await h.callback('menu:help');
  const [edit] = h.sent('editMessageText');
  assert.match(edit.payload.text, /How to use/);
  assert.equal(buttons(edit)[0].callback_data, 'menu:start');
  assert.equal(h.sent('answerCallbackQuery').length, 1);
  await h.callback('menu:about');
  assert.match(h.sent('editMessageText')[1].payload.text, /Torrent Converter<\/b> v2\./);
  assert.ok(buttons(h.sent('editMessageText')[1]).some((b) => b.url?.includes('tlgrmcbot?start=testconverterbot-review')));
});

test('/help and /about work, also addressed as /cmd@bot in groups', async () => {
  const h = createHarness();
  await h.text('/help@TestConverterBot', { chat: GROUP_CHAT });
  await h.text('/about');
  const [help, about] = h.sent('sendMessage');
  assert.match(help.payload.text, /Magnet → Torrent/);
  assert.ok(help.payload.reply_parameters, 'group replies quote the command');
  assert.match(about.payload.text, /@WideWine/);
});

test('magnet link → .torrent file with name, trackers and status cleanup', async () => {
  let asked;
  const h = createHarness({ fetcher: fakeFetcher(async (magnet) => ((asked = magnet), { info: seeded.rawInfo, cached: false })) });
  await h.text(`here you go: ${MAGNET}`);
  assert.equal(asked.infoHash, seeded.infoHash);

  const [status] = h.sent('sendMessage');
  assert.match(status.payload.text, /Fetching torrent metadata/);
  assert.match(buttons(status)[0].callback_data, /^cancel:/);

  const [doc] = h.sent('sendDocument');
  assert.equal(doc.payload.document.filename, 'Ubuntu Server .iso.torrent');
  assert.match(doc.payload.caption, /Ubuntu &lt;Server&gt;\.iso/);
  assert.match(doc.payload.caption, /3\.80 GiB/);
  assert.equal(doc.payload.reply_parameters.allow_sending_without_reply, true);
  const parsed = await parseTorrent(doc.payload.document.fileData);
  assert.equal(parsed.infoHash, seeded.infoHash);
  assert.deepEqual(parsed.announce, ['udp://tracker.example:1337/announce']);

  assert.equal(h.sent('deleteMessage').length, 1);
  assert.deepEqual(h.stats.counters.magnet, { ok: 1, failed: 0 });
});

test('invalid magnet links get a helpful error', async () => {
  const h = createHarness({ fetcher: fakeFetcher(async () => assert.fail('must not fetch')) });
  await h.text('magnet:?xt=urn:btih:nothex');
  assert.match(h.sent('sendMessage')[0].payload.text, /doesn't look like a valid magnet/);
});

test('metadata timeouts are explained to the user', async () => {
  const h = createHarness({
    fetcher: fakeFetcher(async () => {
      throw new MetadataTimeoutError({ peers: 0, connected: 0 });
    }),
  });
  await h.text(MAGNET);
  const [edit] = h.sent('editMessageText');
  assert.match(edit.payload.text, /couldn't find anyone sharing this torrent/);
  assert.equal(edit.payload.reply_markup, undefined, 'cancel button removed');
  assert.deepEqual(h.stats.counters.magnet, { ok: 0, failed: 1 });
});

test('the requester (and only the requester) can cancel a conversion', async () => {
  const h = createHarness({
    fetcher: fakeFetcher(
      (_magnet, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
    ),
  });
  const running = h.text(MAGNET);
  await waitFor(() => h.sent('sendMessage').length === 1);
  const data = buttons(h.sent('sendMessage')[0])[0].callback_data;

  await h.callback(data, { from: OTHER_USER });
  assert.match(h.sent('answerCallbackQuery')[0].payload.text, /Only the person/);

  await h.callback(data, { from: USER });
  await running;
  assert.match(h.sent('editMessageText').at(-1).payload.text, /Cancelled/);
  await h.callback(data, { from: USER });
  assert.match(h.sent('answerCallbackQuery').at(-1).payload.text, /already finished/);
});

test('users are limited in how many conversions run at once', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const h = createHarness({
    config: { maxJobsPerUser: 1 },
    fetcher: fakeFetcher(async () => (await gate, { info: seeded.rawInfo, cached: false })),
  });
  const first = h.text(MAGNET);
  await waitFor(() => h.sent('sendMessage').length === 1);
  await h.text(MAGNET);
  assert.match(h.sent('sendMessage')[1].payload.text, /already have 1 conversion running/);
  release();
  await first;
  assert.equal(h.sent('sendDocument').length, 1);
});

test('shutdown aborts running conversions with a restart notice', async () => {
  const h = createHarness({
    fetcher: fakeFetcher(
      (_magnet, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
    ),
  });
  const running = h.text(MAGNET);
  await waitFor(() => h.sent('sendMessage').length === 1);
  h.converter.abortAll();
  await running;
  assert.match(h.sent('editMessageText').at(-1).payload.text, /restarting/);
  await h.text(MAGNET);
  assert.match(h.sent('sendMessage').at(-1).payload.text, /restarting/);
});

test('groups: only magnet-first messages, /convert and /cmd magnet (not other bots) trigger', async () => {
  const h = createHarness({ fetcher: fakeFetcher() });
  await h.text(`look at this magnet ${MAGNET}`, { chat: GROUP_CHAT });
  await h.text(`/leech@OtherBot ${MAGNET}`, { chat: GROUP_CHAT });
  await h.text('just chatting', { chat: GROUP_CHAT });
  await h.document({ ...torrentDoc, file_name: 'notes.pdf', mime_type: 'application/pdf' }, { chat: GROUP_CHAT });
  assert.equal(h.calls.length, 0, 'bot stays quiet');

  await h.text(MAGNET, { chat: GROUP_CHAT });
  await h.text(`/mirror ${MAGNET}`, { chat: GROUP_CHAT });
  await h.text(`/convert@TestConverterBot ${MAGNET}`, { chat: GROUP_CHAT });
  await h.text('/convert', { chat: GROUP_CHAT, reply_to_message: { message_id: 3, date: 0, chat: GROUP_CHAT, text: `pls ${MAGNET}` } });
  assert.equal(h.sent('sendDocument').length, 4);
});

test('/convert without anything to convert explains itself', async () => {
  const h = createHarness();
  await h.text('/convert', { chat: GROUP_CHAT });
  assert.match(h.sent('sendMessage')[0].payload.text, /\/convert magnet:\?/);
});

test('.torrent file → magnet link with details and a copy button', async () => {
  const file = makeTorrent({ name: 'A&B <test>', length: 2048, announce: ['udp://t.example:80/announce'] });
  let requestedPath;
  const h = createHarness({ downloadFile: async (path) => ((requestedPath = path), file.torrent) });
  await h.document(torrentDoc);
  assert.equal(h.sent('getFile')[0].payload.file_id, 'f1');
  assert.equal(requestedPath, 'documents/file_1.torrent');
  const [msg] = h.sent('sendMessage');
  assert.match(msg.payload.text, /A&amp;B &lt;test&gt;/);
  assert.match(msg.payload.text, /2\.00 KiB · 📁 1 file · 📡 1 tracker/);
  assert.match(msg.payload.text, new RegExp(`<code>magnet:\\?xt=urn:btih:${file.infoHash}&amp;dn=A%26B%20%3Ctest%3E`));
  const [copy] = buttons(msg);
  assert.match(copy.copy_text.text, new RegExp(`^magnet:\\?xt=urn:btih:${file.infoHash}`));
  assert.deepEqual(h.stats.counters.torrent, { ok: 1, failed: 0 });
});

test('files named .torrent are accepted even with a generic MIME type; /convert works on replies', async () => {
  const file = makeTorrent();
  const h = createHarness({ downloadFile: async () => file.torrent });
  await h.document({ ...torrentDoc, mime_type: 'application/octet-stream' });
  await h.text('/convert', { chat: GROUP_CHAT, reply_to_message: { message_id: 3, date: 0, chat: GROUP_CHAT, document: torrentDoc } });
  assert.equal(h.sent('sendMessage').filter((c) => /Magnet link/.test(c.payload.text)).length, 2);
});

test('huge magnet links are attached as a file', async () => {
  const announce = Array.from({ length: 150 }, (_, i) => `udp://tracker-${i}.example.org:1337/announce`);
  const file = makeTorrent({ announce });
  const h = createHarness({ downloadFile: async () => file.torrent });
  await h.document(torrentDoc);
  const [msg] = h.sent('sendMessage');
  assert.ok(msg.payload.text.length < 4096);
  assert.match(msg.payload.text, /attached as a file/);
  const [attachment] = h.sent('sendDocument');
  assert.match(attachment.payload.document.filename, /\.magnet\.txt$/);
  assert.equal((await parseTorrent(attachment.payload.document.fileData.toString())).announce.length, 150);
});

test('bad documents: not a torrent, invalid torrent, too large', async () => {
  const h = createHarness({ downloadFile: async () => Buffer.from('<html>nope</html>') });
  await h.document({ ...torrentDoc, file_name: 'photo.jpg', mime_type: 'image/jpeg' });
  await h.document(torrentDoc);
  await h.document({ ...torrentDoc, file_size: 25 * 1024 * 1024 });
  const texts = h.sent('sendMessage').map((c) => c.payload.text);
  assert.match(texts[0], /Please send a <b>\.torrent<\/b> file/);
  assert.match(texts[1], /isn't a valid \.torrent file/);
  assert.match(texts[2], /too big/);
  assert.equal(h.sent('getFile').length, 1, 'oversized files are not downloaded');
});

test('private chat fallbacks: plain text and unknown commands get hints', async () => {
  const h = createHarness();
  await h.text('hello?');
  await h.text('/whatever');
  const [hint, unknown] = h.sent('sendMessage').map((c) => c.payload.text);
  assert.match(hint, /Send me a <b>magnet link<\/b>/);
  assert.match(unknown, /don't know that command/);
});

test('/stats is owner-only and includes database counts', async () => {
  const store = new Store(':memory:');
  const h = createHarness({ store, fetcher: fakeFetcher() });
  await h.text('/start');
  await h.text('/stats');
  assert.match(h.sent('sendMessage').at(-1).payload.text, /don't know that command/);
  await h.text('/stats', { from: OWNER, chat: OWNER_CHAT });
  const stats = h.sent('sendMessage').at(-1).payload.text;
  assert.match(stats, /Users: 2 \(2 reachable\)/);
  assert.match(stats, /DHT nodes: 12/);
  store.close();
});

test('subscriber tracking: users, blocks, groups, and the log channel', async () => {
  const store = new Store(':memory:');
  const h = createHarness({ store, config: { logChatId: -100777, logIntervalMs: 20 } });
  await h.text('/start');
  await h.text('/start'); // same user again: not "new"
  await h.text('hi', { chat: GROUP_CHAT }); // group discovered silently
  await h.myChatMember({ chat: { ...GROUP_CHAT, id: -100555, title: 'New <group>' }, before: 'left', after: 'member' });
  await h.myChatMember({ chat: PRIVATE_CHAT, before: 'member', after: 'kicked' });

  let counts = store.counts();
  assert.equal(counts.users, 1);
  assert.equal(counts.activeUsers, 0, 'blocked users are not broadcast targets');
  assert.equal(counts.activeChats, 2);

  await h.myChatMember({ chat: PRIVATE_CHAT, before: 'kicked', after: 'member' });
  await h.myChatMember({ chat: GROUP_CHAT, before: 'member', after: 'left' });
  counts = store.counts();
  assert.equal(counts.activeUsers, 1);
  assert.equal(counts.activeChats, 1);
  assert.match(h.sent('sendMessage').find((c) => /Thanks for adding me/.test(c.payload.text)).payload.text, /convert/);

  await waitFor(() => h.sent('sendMessage').some((c) => c.payload.chat_id === -100777));
  const logs = h.sent('sendMessage').filter((c) => c.payload.chat_id === -100777);
  assert.equal(logs.length, 1, 'log entries are batched into one message');
  assert.equal(logs[0].payload.disable_notification, true);
  assert.match(logs[0].payload.text, /#NewUser <a href="tg:\/\/user\?id=7">Ann<\/a>/);
  assert.match(logs[0].payload.text, /#NewGroup <b>New &lt;group&gt;<\/b>/);
  assert.match(logs[0].payload.text, /#LeftGroup/);
  assert.equal(logs[0].payload.text.match(/#NewUser/g).length, 1);
  store.close();
});

async function seedSubscribers(store, count, { groups = 0 } = {}) {
  for (let i = 1; i <= count; i++) store.saveUser({ id: 1000 + i, first_name: `U${i}` });
  for (let i = 1; i <= groups; i++) store.saveChat({ id: -1000 - i, type: 'supergroup', title: `G${i}` });
}

test('/broadcast: confirm, copy to everyone at a paced rate, skip unreachable users', async () => {
  const store = new Store(':memory:');
  await seedSubscribers(store, 5, { groups: 2 });
  let rateLimited = false;
  const h = createHarness({
    store,
    config: { broadcastRate: 30, logChatId: -100777, logIntervalMs: 20 },
    respond: (method, payload) => {
      if (method !== 'copyMessage') return;
      if (payload.chat_id === 1002) return { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' };
      if (payload.chat_id === 1003) return { ok: false, error_code: 400, description: 'Bad Request: something odd' };
      if (payload.chat_id === 1004 && !rateLimited) {
        rateLimited = true;
        return { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 0 } };
      }
    },
  });

  await h.text('/broadcast'); // non-owner: unknown
  assert.match(h.sent('sendMessage').at(-1).payload.text, /don't know that command/);

  await h.text('/broadcast', { from: OWNER, chat: OWNER_CHAT });
  assert.match(h.sent('sendMessage').at(-1).payload.text, /reply to it/);

  const source = { message_id: 42, date: 0, chat: OWNER_CHAT, from: OWNER, text: 'Big news!' };
  await h.text('/broadcast', { from: OWNER, chat: OWNER_CHAT, reply_to_message: source });
  const confirm = h.sent('sendMessage').at(-1);
  // 5 seeded users + Ann (from the first /broadcast) + the owner = 7 users
  assert.match(confirm.payload.text, /7 users/);
  assert.deepEqual(buttons(confirm).map((b) => b.callback_data), ['bc:go:users:42', 'bc:go:all:42', 'bc:no']);

  const startedAt = Date.now();
  await h.callback('bc:go:all:42', { from: OWNER, chat: OWNER_CHAT, messageId: confirm.payload.message_id ?? 1 });
  await waitFor(() => h.sent('sendMessage').some((c) => /#Broadcast #1 ✅ finished/.test(c.payload.text)), 5000);

  const copies = h.sent('copyMessage');
  assert.ok(copies.every((c) => c.payload.from_chat_id === 99 && c.payload.message_id === 42));
  const targets = copies.map((c) => c.payload.chat_id);
  // users ascending, then groups ascending; 1004 retried once after the 429
  assert.deepEqual(targets, [7, 99, 1001, 1002, 1003, 1004, 1004, 1005, -1002, -1001]);
  assert.ok(Date.now() - startedAt >= (9 * 1000) / 30 - 50, 'sends are paced');

  const b = store.getBroadcast(1);
  assert.equal(b.status, 'done');
  assert.deepEqual([b.sent, b.unreachable, b.failed, b.total], [7, 1, 1, 9]);
  assert.equal(store.counts().activeUsers, 6, 'the user who blocked the bot is skipped next time');
  assert.ok(h.sent('editMessageText').some((c) => /Broadcast #1 ✅ finished/.test(c.payload.text)));
  store.close();
});

test('/broadcast can be stopped, and only one runs at a time', async () => {
  const store = new Store(':memory:');
  await seedSubscribers(store, 50);
  const h = createHarness({ store, config: { broadcastRate: 10 } });
  const source = { message_id: 42, date: 0, chat: OWNER_CHAT, from: OWNER, text: 'news' };
  await h.callback('bc:go:users:42', { from: OWNER, chat: OWNER_CHAT });
  await waitFor(() => h.sent('copyMessage').length >= 2);

  await h.text('/broadcast', { from: OWNER, chat: OWNER_CHAT, reply_to_message: source });
  assert.match(h.sent('sendMessage').at(-1).payload.text, /still running/);

  await h.callback('bc:cancel:1', { from: OWNER, chat: OWNER_CHAT });
  await waitFor(() => store.getBroadcast(1).status === 'cancelled');
  const sentSoFar = h.sent('copyMessage').length;
  await tick(300);
  assert.equal(h.sent('copyMessage').length, sentSoFar, 'no more messages after stopping');
  assert.ok(sentSoFar < 50);
  store.close();
});

test('/broadcast resumes after a restart without re-sending, and stops if the source is deleted', async () => {
  const store = new Store(':memory:');
  await seedSubscribers(store, 30);
  const first = createHarness({ store, config: { broadcastRate: 30 } });
  await first.callback('bc:go:users:42', { from: OWNER, chat: OWNER_CHAT });
  await waitFor(() => first.sent('copyMessage').length >= 5);
  await first.broadcaster.stop(); // like pm2 restart
  const before = first.sent('copyMessage').map((c) => c.payload.chat_id);
  assert.equal(store.getBroadcast(1).status, 'running');
  assert.match(first.sent('editMessageText').at(-1).payload.text, /Paused for a bot restart/);

  const second = createHarness({ store, config: { broadcastRate: 30 } });
  second.broadcaster.resume();
  await waitFor(() => store.getBroadcast(1).status === 'done', 5000);
  const after = second.sent('copyMessage').map((c) => c.payload.chat_id);
  const everyone = [...before, ...after];
  assert.equal(new Set(everyone).size, everyone.length, 'nobody received it twice');
  assert.equal(everyone.length, 31); // 30 seeded + the owner (who pressed the button)

  const third = createHarness({
    store,
    respond: (method) =>
      method === 'copyMessage' ? { ok: false, error_code: 400, description: 'Bad Request: message to copy not found' } : undefined,
  });
  await third.callback('bc:go:users:43', { from: OWNER, chat: OWNER_CHAT });
  await waitFor(() => store.getBroadcast(2).status === 'failed');
  assert.match(store.getBroadcast(2).error, /deleted/);
  assert.equal(third.sent('copyMessage').length, 1);
  store.close();
});

test('log channel falls back to plain text if Telegram cannot parse the HTML', async () => {
  const store = new Store(':memory:');
  const h = createHarness({
    store,
    config: { logChatId: -100777, logIntervalMs: 20 },
    respond: (method, payload) =>
      method === 'sendMessage' && payload.chat_id === -100777 && payload.parse_mode === 'HTML'
        ? { ok: false, error_code: 400, description: "Bad Request: can't parse entities" }
        : undefined,
  });
  await h.text('/start');
  await waitFor(() => h.sent('sendMessage').filter((c) => c.payload.chat_id === -100777).length === 2);
  const [html, plain] = h.sent('sendMessage').filter((c) => c.payload.chat_id === -100777);
  assert.equal(html.payload.parse_mode, 'HTML');
  assert.equal(plain.payload.parse_mode, undefined);
  assert.equal(plain.payload.text, html.payload.text);
  store.close();
});

test('people posting as a channel get their own limit and can be cancelled from the chat', async () => {
  const h = createHarness({
    config: { maxJobsPerUser: 1 },
    fetcher: fakeFetcher(
      (_magnet, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
    ),
  });
  const channelBot = { id: 136817688, is_bot: true, first_name: 'Channel' };
  const asChannel = (id) =>
    h.bot.handleUpdate({
      update_id: 9000 + id,
      message: { message_id: id, date: 0, chat: GROUP_CHAT, from: channelBot, sender_chat: { id: -100900 - id, type: 'channel', title: `C${id}` }, text: MAGNET },
    });
  const a = asChannel(1);
  const b = asChannel(2);
  await waitFor(() => h.sent('sendMessage').length === 2);
  assert.ok(h.sent('sendMessage').every((c) => /Fetching/.test(c.payload.text)), 'two different channels are not one "user"');
  for (const call of h.sent('sendMessage')) await h.callback(buttons(call)[0].callback_data, { from: OTHER_USER, chat: GROUP_CHAT });
  await Promise.all([a, b]);
  assert.equal(h.sent('editMessageText').filter((c) => /Cancelled/.test(c.payload.text)).length, 2);
});
