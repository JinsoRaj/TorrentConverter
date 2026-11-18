// Offline tests of the BitTorrent networking code against local fake trackers
// and a real (local) seeding peer.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import bencode from 'bencode';
import Protocol from 'bittorrent-protocol';
import utMetadata from 'ut_metadata';
import { announce } from '../src/lib/trackers.js';
import { MetadataFetcher, MetadataTimeoutError } from '../src/lib/metadata.js';
import { silentLogger } from '../src/logger.js';
import { makeTorrent } from './helpers.js';

const INFO_HASH = Buffer.alloc(20, 0xab);
const PEER_ID = Buffer.from('-TC2000-testtesttest');
const peerBytes = (ip, port) => Buffer.from([...ip.split('.').map(Number), port >> 8, port & 255]);

const cleanups = [];
after(() => Promise.all(cleanups.map((fn) => fn())));

test('UDP tracker announce (BEP 15)', async () => {
  const server = dgram.createSocket('udp4');
  let announced;
  server.on('message', (msg, rinfo) => {
    const action = msg.readUInt32BE(8);
    const tid = msg.readUInt32BE(12);
    if (action === 0) {
      assert.equal(msg.readBigUInt64BE(0), 0x41727101980n);
      const res = Buffer.alloc(16);
      res.writeUInt32BE(0, 0);
      res.writeUInt32BE(tid, 4);
      res.writeBigUInt64BE(1234n, 8);
      server.send(res, rinfo.port, rinfo.address);
    } else if (action === 1) {
      announced = { infoHash: msg.subarray(16, 36), peerId: msg.subarray(36, 56), connectionId: msg.readBigUInt64BE(0) };
      const header = Buffer.alloc(20);
      header.writeUInt32BE(1, 0);
      header.writeUInt32BE(tid, 4);
      header.writeUInt32BE(1800, 8);
      server.send(
        Buffer.concat([header, peerBytes('1.2.3.4', 6881), peerBytes('10.0.0.1', 6881), peerBytes('5.6.7.8', 51413)]),
        rinfo.port,
        rinfo.address,
      );
    }
  });
  server.bind(0, '127.0.0.1');
  await once(server, 'listening');
  cleanups.push(() => server.close());

  const url = `udp://127.0.0.1:${server.address().port}/announce`;
  const peers = await announce(url, { infoHash: INFO_HASH, peerId: PEER_ID, allowPrivate: false }).catch((e) => e);
  assert.match(peers.message, /not public/, 'trackers on private addresses are refused by default');

  const allowed = await announce(url, { infoHash: INFO_HASH, peerId: PEER_ID, allowPrivate: true });
  // Private peer addresses are still filtered unless allowPrivate is set.
  assert.deepEqual(allowed, ['1.2.3.4:6881', '10.0.0.1:6881', '5.6.7.8:51413']);
  assert.deepEqual(announced.infoHash, INFO_HASH);
  assert.deepEqual(announced.peerId, PEER_ID);
  assert.equal(announced.connectionId, 1234n);
});

test('UDP tracker error and timeout handling', async () => {
  const server = dgram.createSocket('udp4');
  server.on('message', (msg, rinfo) => {
    const res = Buffer.concat([Buffer.alloc(8), Buffer.from('torrent not registered')]);
    res.writeUInt32BE(3, 0);
    res.writeUInt32BE(msg.readUInt32BE(12), 4);
    server.send(res, rinfo.port, rinfo.address);
  });
  server.bind(0, '127.0.0.1');
  await once(server, 'listening');
  cleanups.push(() => server.close());
  await assert.rejects(
    announce(`udp://127.0.0.1:${server.address().port}`, { infoHash: INFO_HASH, peerId: PEER_ID, allowPrivate: true }),
    /torrent not registered/,
  );

  const silent = dgram.createSocket('udp4');
  silent.bind(0, '127.0.0.1');
  await once(silent, 'listening');
  cleanups.push(() => silent.close());
  await assert.rejects(
    announce(`udp://127.0.0.1:${silent.address().port}`, {
      infoHash: INFO_HASH,
      peerId: PEER_ID,
      allowPrivate: true,
      timeoutMs: 200,
    }),
    /timed out/,
  );
});

test('HTTP tracker announce (compact, dictionary and failure responses)', async () => {
  let mode = 'compact';
  let lastQuery;
  const server = http.createServer((req, res) => {
    lastQuery = req.url;
    if (mode === 'compact') {
      res.end(bencode.encode({ interval: 1800, peers: Buffer.concat([peerBytes('1.2.3.4', 1000), peerBytes('8.8.4.4', 2000)]) }));
    } else if (mode === 'dict') {
      res.end(bencode.encode({ interval: 1800, peers: [{ ip: '9.9.9.9', port: 3000, 'peer id': 'x' }] }));
    } else if (mode === 'redirect') {
      res.writeHead(302, { location: 'http://169.254.169.254/' }).end();
    } else {
      res.end(bencode.encode({ 'failure reason': 'unregistered torrent' }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanups.push(() => new Promise((r) => server.close(r)));
  const url = `http://127.0.0.1:${server.address().port}/announce?passkey=abc`;
  const opts = { infoHash: INFO_HASH, peerId: PEER_ID, allowPrivate: true };

  assert.deepEqual(await announce(url, opts), ['1.2.3.4:1000', '8.8.4.4:2000']);
  assert.match(lastQuery, /^\/announce\?passkey=abc&info_hash=(%ab){20}&peer_id=/);
  mode = 'dict';
  assert.deepEqual(await announce(url, opts), ['9.9.9.9:3000']);
  mode = 'redirect';
  await assert.rejects(announce(url, opts), /HTTP 302/); // redirects are never followed
  mode = 'failure';
  await assert.rejects(announce(url, opts), /unregistered torrent/);
});

/** A local peer that seeds the metadata of `torrent` over ut_metadata. */
async function startSeeder(torrent, { lieAboutHash = false } = {}) {
  const server = net.createServer((socket) => {
    const wire = new Protocol();
    socket.on('error', () => {});
    wire.on('error', () => socket.destroy());
    socket.pipe(wire).pipe(socket);
    wire.use(utMetadata(torrent));
    wire.on('handshake', (infoHash) => {
      wire.handshake(lieAboutHash ? 'ff'.repeat(20) : infoHash, Buffer.from('-SEED00-seedseedseed'));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanups.push(() => new Promise((r) => server.close(r)));
  return `127.0.0.1:${server.address().port}`;
}

const newFetcher = () =>
  new MetadataFetcher({ logger: silentLogger, dht: false, trackers: [], allowPrivate: true });

test('MetadataFetcher downloads and verifies metadata from a peer, then caches it', async () => {
  const { torrent, rawInfo, infoHash } = makeTorrent({ name: 'seeded.bin', length: 500_000 });
  const seeder = await startSeeder(torrent);
  const fetcher = newFetcher();
  await fetcher.start();

  const progress = [];
  const result = await fetcher.fetch(
    { infoHash, peerAddresses: [seeder] },
    { timeoutMs: 5000, onProgress: (p) => progress.push(p) },
  );
  assert.equal(result.cached, false);
  assert.deepEqual(result.info, rawInfo);

  const again = await fetcher.fetch({ infoHash }, { timeoutMs: 100 });
  assert.equal(again.cached, true);
  assert.equal(fetcher.stats.cachedTorrents, 1);
  await fetcher.destroy();
});

test('MetadataFetcher shares one network job between concurrent requests', async () => {
  const { torrent, rawInfo, infoHash } = makeTorrent({ name: 'shared.bin' });
  const seeder = await startSeeder(torrent);
  const fetcher = newFetcher();
  const [a, b] = await Promise.all([
    fetcher.fetch({ infoHash, peerAddresses: [seeder] }, { timeoutMs: 5000 }),
    fetcher.fetch({ infoHash, peerAddresses: [] }, { timeoutMs: 5000 }),
  ]);
  assert.deepEqual(a.info, rawInfo);
  assert.deepEqual(b.info, rawInfo);
  await fetcher.destroy();
});

test('MetadataFetcher ignores peers that answer for a different torrent', async () => {
  const { torrent, infoHash } = makeTorrent({ name: 'liar.bin' });
  const liar = await startSeeder(torrent, { lieAboutHash: true });
  const fetcher = newFetcher();
  await assert.rejects(fetcher.fetch({ infoHash, peerAddresses: [liar] }, { timeoutMs: 800 }), MetadataTimeoutError);
  await fetcher.destroy();
});

test('MetadataFetcher times out with stats, and can be aborted', async () => {
  const fetcher = newFetcher();
  const infoHash = 'cd'.repeat(20);
  const err = await fetcher.fetch({ infoHash, peerAddresses: ['127.0.0.1:1'] }, { timeoutMs: 300 }).catch((e) => e);
  assert.ok(err instanceof MetadataTimeoutError);
  assert.equal(err.stats.peers, 1);

  const controller = new AbortController();
  const pending = fetcher.fetch({ infoHash }, { timeoutMs: 10_000, signal: controller.signal });
  controller.abort(new Error('user cancelled'));
  await assert.rejects(pending, /user cancelled/);
  assert.equal(fetcher.stats.activeLookups, 0);
  await fetcher.destroy();
});

test('MetadataFetcher never connects to private addresses unless allowed', async () => {
  const { torrent, infoHash } = makeTorrent({ name: 'private-net.bin' });
  const seeder = await startSeeder(torrent);
  const fetcher = new MetadataFetcher({ logger: silentLogger, dht: false, trackers: [] });
  const err = await fetcher.fetch({ infoHash, peerAddresses: [seeder] }, { timeoutMs: 300 }).catch((e) => e);
  assert.ok(err instanceof MetadataTimeoutError);
  assert.equal(err.stats.peers, 0);
  await fetcher.destroy();
});

/** A local "peer" that completes the BitTorrent handshake and then misbehaves. */
async function startEvilPeer(infoHash, misbehave) {
  let closedAt = null;
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.on('close', () => (closedAt ??= Date.now()));
    socket.once('data', () => {
      const handshake = Buffer.concat([
        Buffer.from([19]),
        Buffer.from('BitTorrent protocol'),
        Buffer.from([0, 0, 0, 0, 0, 0x10, 0, 0]),
        Buffer.from(infoHash, 'hex'),
        Buffer.alloc(20, 1),
      ]);
      socket.write(handshake);
      misbehave(socket);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanups.push(() => new Promise((r) => server.close(r)));
  return { address: `127.0.0.1:${server.address().port}`, closedAt: () => closedAt };
}

const btMessage = (id, payload) => {
  const body = Buffer.concat([Buffer.from([id]), payload]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([length, body]);
};
const extended = (extId, dict) => btMessage(20, Buffer.concat([Buffer.from([extId]), Buffer.from(dict)]));

test('malformed ut_metadata messages from a peer cannot crash the bot', async () => {
  const infoHash = 'ab'.repeat(20);
  const attacks = {
    // ut_metadata request before any extended handshake ("Unrecognized extension")
    request: (s) => s.write(extended(1, 'd8:msg_typei0e5:piecei0ee')),
    // metadata data before the size is known (undefined buffer)
    data: (s) => s.write(extended(1, `d8:msg_typei1e5:piecei0ee${'x'.repeat(100)}`)),
    // data for an out-of-range piece (RangeError)
    range: (s) => {
      s.write(extended(0, 'd1:md11:ut_metadatai3ee13:metadata_sizei100ee'));
      setTimeout(() => s.write(extended(3, `d8:msg_typei1e5:piecei5ee${'x'.repeat(100)}`)), 50);
    },
  };
  for (const [name, attack] of Object.entries(attacks)) {
    const peer = await startEvilPeer(infoHash, attack);
    const fetcher = newFetcher();
    const err = await fetcher.fetch({ infoHash, peerAddresses: [peer.address] }, { timeoutMs: 600 }).catch((e) => e);
    assert.ok(err instanceof MetadataTimeoutError, `${name}: ${err}`);
    await fetcher.destroy();
  }
});

test('peers announcing huge messages or metadata are cut off early', async () => {
  const infoHash = 'cd'.repeat(20);
  // A message that claims to be 100 MB long, then a stream of data.
  const flood = await startEvilPeer(infoHash, (s) => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(100 * 1024 * 1024);
    s.write(header);
    const chunk = Buffer.alloc(64 * 1024);
    const pump = () => {
      while (!s.destroyed && s.write(chunk));
      if (!s.destroyed) s.once('drain', pump);
    };
    pump();
  });
  // An extended handshake claiming 50 MB of metadata (over the 8 MB cap).
  const bigMeta = await startEvilPeer(infoHash, (s) => s.write(extended(0, 'd1:md11:ut_metadatai3ee13:metadata_sizei52428800ee')));

  const fetcher = newFetcher();
  const started = Date.now();
  await assert.rejects(
    fetcher.fetch({ infoHash, peerAddresses: [flood.address, bigMeta.address] }, { timeoutMs: 1500 }),
    MetadataTimeoutError,
  );
  assert.ok(flood.closedAt() && flood.closedAt() - started < 1000, 'flooding peer disconnected quickly');
  assert.ok(bigMeta.closedAt() && bigMeta.closedAt() - started < 1000, 'oversized metadata refused');
  await fetcher.destroy();
});
