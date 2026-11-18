import { test } from 'node:test';
import assert from 'node:assert/strict';
import parseTorrent from 'parse-torrent';
import { escapeHtml, formatBytes, formatDuration, sanitizeFilename, truncate } from '../src/lib/format.js';
import { isPublicIp, parseHostPort, resolvePublic } from '../src/lib/address.js';
import { extractMagnets, InvalidMagnetError, parseMagnet, UnsupportedMagnetError } from '../src/lib/magnet.js';
import {
  buildMagnet,
  buildTorrentFile,
  InvalidTorrentError,
  summarizeTorrent,
  UnsupportedTorrentError,
} from '../src/lib/torrent.js';
import { extractRawInfo } from '../src/lib/bencode-raw.js';
import { LRUCache } from '../src/lib/lru.js';
import { BusyError, JobLimiter } from '../src/lib/limiter.js';
import { loadConfig, ConfigError } from '../src/config.js';
import { logError, magnetResult } from '../src/texts.js';
import bencode from 'bencode';
import { makeTorrent, sha1, tick } from './helpers.js';

const HASH = 'a3b4136a174e30b121a6bb6ab75b577ea7eda5f3';

test('format helpers', () => {
  assert.equal(escapeHtml('<b>&"x"</b>'), '&lt;b&gt;&amp;&quot;x&quot;&lt;/b&gt;');
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.50 KiB');
  assert.equal(formatBytes(4080486400), '3.80 GiB');
  assert.equal(formatBytes(undefined), 'unknown');
  assert.equal(formatDuration(5_000), '5s');
  assert.equal(formatDuration(93_784_000), '1d 2h 3m');
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(truncate('😀😀😀', 3), '😀😀😀');
  assert.equal(sanitizeFilename('a/b\\c:d*?"<>|.txt'), 'a b c d .txt');
  assert.equal(sanitizeFilename('...hidden. '), 'hidden');
  assert.equal(sanitizeFilename('  '), 'download');
});

test('isPublicIp rejects private, loopback, link-local and reserved ranges', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.158.213.92', '2606:4700:4700::1111']) assert.ok(isPublicIp(ip), ip);
  for (const ip of [
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', 'not-an-ip', undefined,
    '::7f00:1', '64:ff9b::7f00:1', '2002:7f00:1::1',
  ]) {
    assert.equal(isPublicIp(ip), false, String(ip));
  }
});

test('parseHostPort', () => {
  assert.deepEqual(parseHostPort('1.2.3.4:6881'), { host: '1.2.3.4', port: 6881 });
  assert.deepEqual(parseHostPort('[2001:db8::1]:51413'), { host: '2001:db8::1', port: 51413 });
  assert.equal(parseHostPort('1.2.3.4:0'), null);
  assert.equal(parseHostPort('1.2.3.4:70000'), null);
  assert.equal(parseHostPort('garbage'), null);
});

test('resolvePublic refuses names that resolve to private addresses', async () => {
  assert.deepEqual(await resolvePublic('localhost'), []);
  assert.deepEqual(await resolvePublic('127.0.0.1'), []);
  assert.deepEqual(await resolvePublic('8.8.8.8'), [{ address: '8.8.8.8', family: 4 }]);
  assert.equal((await resolvePublic('127.0.0.1', { allowPrivate: true })).length, 1);
});

test('extractMagnets finds, cleans and dedupes magnet links', () => {
  const text = `Look (magnet:?xt=urn:btih:${HASH}&dn=Ubuntu). Also MAGNET:?xt=urn:btih:${HASH.toUpperCase()}, and again magnet:?xt=urn:btih:${HASH}&dn=Ubuntu!`;
  assert.deepEqual(extractMagnets(text), [`magnet:?xt=urn:btih:${HASH}&dn=Ubuntu`, `MAGNET:?xt=urn:btih:${HASH.toUpperCase()}`]);
  assert.deepEqual(extractMagnets(text, 1).length, 1);
  assert.deepEqual(extractMagnets(''), []);
  assert.deepEqual(extractMagnets(undefined), []);
  assert.deepEqual(extractMagnets('no links here'), []);
});

test('parseMagnet handles hex and base32 hashes, names, trackers and web seeds', async () => {
  const m = await parseMagnet(
    `magnet:?xt=urn:btih:${HASH.toUpperCase()}&dn=My+File%20%F0%9F%98%80&tr=udp%3A%2F%2Ft.example%3A80&tr=udp%3A%2F%2Ft.example%3A80&ws=https%3A%2F%2Fseed.example%2F`,
  );
  assert.equal(m.infoHash, HASH);
  assert.equal(m.name, 'My File 😀');
  assert.deepEqual(m.announce, ['udp://t.example:80']);
  assert.deepEqual(m.urlList, ['https://seed.example/']);

  const base32 = await parseMagnet('magnet:?xt=urn:btih:UO2BG2QXJYYLCINGXNVLOW2XP2T63JPT');
  assert.equal(base32.infoHash, HASH);
});

test('parseMagnet rejects junk and flags v2-only magnets', async () => {
  await assert.rejects(parseMagnet('magnet:?xt=urn:btih:zzz'), InvalidMagnetError);
  await assert.rejects(parseMagnet('magnet:?dn=nothing'), InvalidMagnetError);
  await assert.rejects(parseMagnet(`magnet:?xt=urn:btih:${HASH}&dn=%E0%A4%A`), InvalidMagnetError);
  await assert.rejects(parseMagnet(`magnet:?xt=urn:btmh:1220${'ab'.repeat(32)}`), UnsupportedMagnetError);
});

test('buildMagnet encodes every field', () => {
  const uri = buildMagnet({
    infoHash: HASH,
    name: 'A & B',
    length: 42,
    announce: ['udp://t.example:80/announce', 'udp://t.example:80/announce'],
    urlList: ['https://seed.example/x y'],
  });
  assert.equal(
    uri,
    `magnet:?xt=urn:btih:${HASH}&dn=A%20%26%20B&xl=42&tr=udp%3A%2F%2Ft.example%3A80%2Fannounce&ws=https%3A%2F%2Fseed.example%2Fx%20y`,
  );
  assert.equal(buildMagnet({ infoHash: HASH, announce: ['udp://x:1'] }, { trackers: false }), `magnet:?xt=urn:btih:${HASH}`);
});

test('summarizeTorrent reads a .torrent file and builds its magnet', async () => {
  const { torrent, infoHash } = makeTorrent({ name: 'Big <File>', length: 100_000, announce: ['udp://t.example:80'] });
  const s = await summarizeTorrent(torrent);
  assert.equal(s.name, 'Big <File>');
  assert.equal(s.infoHash, infoHash);
  assert.equal(s.length, 100_000);
  assert.equal(s.fileCount, 1);
  assert.equal(s.private, false);
  assert.deepEqual(s.announce, ['udp://t.example:80']);
  const roundTrip = await parseMagnet(s.magnet);
  assert.equal(roundTrip.infoHash, infoHash);
  assert.equal(roundTrip.name, 'Big <File>');
});

test('summarizeTorrent hashes the original info bytes, even when they are not canonical', async () => {
  // Keys deliberately out of order: re-encoding would sort them and change the hash.
  const rawInfo = Buffer.concat([
    Buffer.from('d4:name4:test6:lengthi5e12:piece lengthi16384e6:pieces20:'),
    Buffer.alloc(20, 1),
    Buffer.from('e'),
  ]);
  const torrent = Buffer.concat([Buffer.from('d4:info'), rawInfo, Buffer.from('e')]);
  const s = await summarizeTorrent(torrent);
  assert.equal(s.infoHash, sha1(rawInfo));
  assert.notEqual(s.infoHash, (await parseTorrent(torrent)).infoHash); // the bug this guards against
});

test('summarizeTorrent rejects invalid and v2-only torrents', async () => {
  await assert.rejects(summarizeTorrent(Buffer.from('not a torrent')), InvalidTorrentError);
  await assert.rejects(summarizeTorrent(Buffer.from('d8:announce3:fooe')), InvalidTorrentError);
  await assert.rejects(summarizeTorrent(Buffer.from('d4:infod4:name1:xee')), InvalidTorrentError);
  await assert.rejects(summarizeTorrent(Buffer.from('d4:infod12:meta versioni2e4:name1:xee')), UnsupportedTorrentError);
  await assert.rejects(summarizeTorrent(Buffer.from('d4:info')), InvalidTorrentError);
});

test('buildTorrentFile keeps the info hash and adds trackers and web seeds', async () => {
  const { rawInfo, infoHash } = makeTorrent();
  const file = buildTorrentFile(rawInfo, {
    announce: ['udp://a.example:1', 'http://b.example/announce', 'udp://a.example:1'],
    urlList: ['https://seed.example/'],
  });
  assert.deepEqual(extractRawInfo(file), rawInfo);
  const parsed = await parseTorrent(file);
  assert.equal(parsed.infoHash, infoHash);
  assert.deepEqual(parsed.announce, ['udp://a.example:1', 'http://b.example/announce']);
  assert.deepEqual(parsed.urlList, ['https://seed.example/']);
  assert.match(parsed.createdBy, /^TorrentConverter\//);

  const bare = await parseTorrent(buildTorrentFile(rawInfo));
  assert.equal(bare.infoHash, infoHash);
  assert.deepEqual(bare.announce, []);
});

test('LRUCache evicts least recently used entries by count and bytes', () => {
  const cache = new LRUCache({ maxEntries: 2, maxBytes: 10 });
  cache.set('a', Buffer.alloc(3));
  cache.set('b', Buffer.alloc(3));
  cache.get('a');
  cache.set('c', Buffer.alloc(3));
  assert.ok(cache.get('a'));
  assert.equal(cache.get('b'), undefined);
  cache.set('d', Buffer.alloc(9));
  assert.equal(cache.size, 1);
  assert.equal(cache.bytes, 9);
  cache.set('huge', Buffer.alloc(11));
  assert.equal(cache.get('huge'), undefined);
});

test('JobLimiter caps concurrency, queues in order and respects aborts', async () => {
  const limiter = new JobLimiter({ concurrency: 1, perUser: 1, maxQueue: 1 });
  assert.equal(limiter.acquireUser(1), true);
  assert.equal(limiter.acquireUser(1), false);
  limiter.releaseUser(1);
  assert.equal(limiter.acquireUser(1), true);

  const order = [];
  let release;
  const first = limiter.run(() => new Promise((r) => (release = r)).then(() => order.push('first')));
  const positions = [];
  const second = limiter.run(async () => order.push('second'), { onQueued: (p) => positions.push(p) });
  await assert.rejects(limiter.run(async () => {}), BusyError);
  assert.deepEqual(limiter.stats, { active: 1, queued: 1, users: 1 });
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first', 'second']);
  assert.deepEqual(positions, [1]);
  assert.equal(limiter.stats.active, 0);

  // Aborting while queued removes the job from the queue.
  let releaseBlocker;
  const blocker = limiter.run(() => new Promise((r) => (releaseBlocker = r)));
  const controller = new AbortController();
  const queued = limiter.run(async () => assert.fail('must not run'), { signal: controller.signal });
  controller.abort(new Error('stop'));
  await assert.rejects(queued, /stop/);
  assert.equal(limiter.stats.queued, 0);
  releaseBlocker();
  await blocker;
  await tick();
  assert.equal(limiter.stats.active, 0);
});

test('loadConfig accepts v1 .env files and validates input', () => {
  const config = loadConfig({ BOT_TOKEN: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ', OWNER_ID: '1004813228', DETA_DB_TOKEN: 'x' }, { rootDir: '/app' });
  assert.equal(config.ownerId, 1004813228);
  assert.equal(config.metadataTimeoutMs, 60_000);
  assert.equal(config.dataDir, '/app/data');

  assert.throws(() => loadConfig({}, { rootDir: '/app' }), ConfigError);
  assert.throws(() => loadConfig({ BOT_TOKEN: 'nope' }, { rootDir: '/app' }), /BOT_TOKEN looks invalid/);
  assert.throws(
    () => loadConfig({ BOT_TOKEN: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ', METADATA_TIMEOUT: '5' }, { rootDir: '/app' }),
    /METADATA_TIMEOUT/,
  );
  const warned = loadConfig({ BOT_TOKEN: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ', OWNER_ID: '@me', EXTRA_TRACKERS: 'wss://x, udp://t.example:1' }, { rootDir: '/app' });
  assert.equal(warned.ownerId, undefined);
  assert.deepEqual(warned.extraTrackers, ['udp://t.example:1']);
  assert.equal(warned.warnings.length, 2);
});

test('summarizeTorrent reads huge file lists without decoding them, skipping padding files', async () => {
  const files = [];
  for (let i = 0; i < 100_000; i++) files.push({ length: 10, path: [`f${i}.bin`] });
  files.push({ length: 999, path: ['.pad', '999'], attr: 'p' });
  const torrent = Buffer.from(
    bencode.encode({
      announce: 'udp://a.example:1',
      'announce-list': [['udp://a.example:1'], ['udp://b.example:2']],
      'url-list': 'https://seed.example/',
      info: { name: 'many', 'piece length': 16384, pieces: Buffer.alloc(20 * 62), files },
    }),
  );
  const started = Date.now();
  const s = await summarizeTorrent(torrent);
  assert.equal(s.fileCount, 100_000);
  assert.equal(s.length, 1_000_000);
  assert.deepEqual(s.announce, ['udp://a.example:1', 'udp://b.example:2']);
  assert.deepEqual(s.urlList, ['https://seed.example/']);
  assert.ok(Date.now() - started < 2000);
  await assert.rejects(
    summarizeTorrent(Buffer.from(bencode.encode({ info: { name: 'x', 'piece length': 1, pieces: Buffer.alloc(20), files: [{ length: -1, path: ['a'] }] } }))),
    InvalidTorrentError,
  );
});

test('magnet replies always fit in one Telegram message', async () => {
  const name = '😀'.repeat(300);
  const announce = Array.from({ length: 60 }, (_, i) => `udp://tracker-${i}.example.org:1337/announce`);
  const { rawInfo, infoHash } = makeTorrent({ name, announce });
  const s = await summarizeTorrent(buildTorrentFile(rawInfo, { announce }));
  assert.equal(s.infoHash, infoHash);
  const result = magnetResult(s);
  assert.ok(result.text.length <= 4096, `length ${result.text.length}`);
  assert.equal(result.attachFullMagnet, s.magnet.length > 3500 || result.text.length > 3000);
});

test('log entries stay small even for errors full of HTML special characters', () => {
  const err = new Error('"'.repeat(5000));
  assert.ok(logError('update 1', err).length < 3800);
});
