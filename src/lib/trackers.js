// Minimal BitTorrent tracker client: just enough to ask UDP (BEP 15) and
// HTTP(S) (BEP 3/23) trackers for peers. Pure JS, no native dependencies.

import dgram from 'node:dgram';
import { randomBytes } from 'node:crypto';
import bencode from 'bencode';
import { isPublicIp, resolvePublic } from './address.js';
import { pinnedGet } from './http.js';
import { APP_NAME, APP_VERSION } from '../version.js';

const UDP_PROTOCOL_ID = 0x41727101980n;
const ACTION_CONNECT = 0;
const ACTION_ANNOUNCE = 1;
const ACTION_ERROR = 3;
const EVENT_STARTED = 2;
// We never have any pieces; reporting a non-zero "left" makes trackers
// return seeders to us rather than treating us as a seed.
const LEFT = 16384;
const MAX_HTTP_RESPONSE = 512 * 1024;

/** Trackers we know how to talk to (WebRTC/WebSocket trackers are skipped). */
export function isSupportedTracker(url) {
  return /^(udp|https?):\/\/[^/]/i.test(url);
}

/**
 * @typedef {object} AnnounceOptions
 * @property {Uint8Array} infoHash 20 bytes
 * @property {Uint8Array} peerId 20 bytes
 * @property {number} [port] port we claim to listen on
 * @property {number} [numWant]
 * @property {number} [timeoutMs]
 * @property {AbortSignal} [signal]
 * @property {boolean} [allowPrivate] testing only
 */

/**
 * Announce to one tracker and return the peers it knows ("ip:port" strings).
 * @param {string} url
 * @param {AnnounceOptions} options
 */
export async function announce(url, options) {
  const u = new URL(url);
  if (u.protocol === 'udp:') return announceUdp(u, options);
  if (u.protocol === 'http:' || u.protocol === 'https:') return announceHttp(u, options);
  throw new Error(`Unsupported tracker protocol ${u.protocol}`);
}

/**
 * Announce to many trackers in parallel, reporting peers as they arrive.
 * Never throws; individual tracker failures are passed to `onError`.
 */
export async function announceMany(urls, options, { onPeers, onError } = {}) {
  await Promise.all(
    urls.map(async (url) => {
      try {
        const peers = await announce(url, options);
        if (peers.length) onPeers?.(peers, url);
      } catch (err) {
        onError?.(err, url);
      }
    }),
  );
}

function filterPeers(peers, allowPrivate) {
  return peers.filter((p) => p.port > 0 && p.port <= 65535 && (allowPrivate || isPublicIp(p.host)));
}

function formatPeer({ host, port }) {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

function parseCompactV4(buf) {
  const peers = [];
  for (let i = 0; i + 6 <= buf.length; i += 6) {
    peers.push({ host: `${buf[i]}.${buf[i + 1]}.${buf[i + 2]}.${buf[i + 3]}`, port: (buf[i + 4] << 8) | buf[i + 5] });
  }
  return peers;
}

function parseCompactV6(buf) {
  const peers = [];
  for (let i = 0; i + 18 <= buf.length; i += 18) {
    const groups = [];
    for (let j = 0; j < 16; j += 2) groups.push(((buf[i + j] << 8) | buf[i + j + 1]).toString(16));
    peers.push({ host: groups.join(':'), port: (buf[i + 16] << 8) | buf[i + 17] });
  }
  return peers;
}

async function announceUdp(u, { infoHash, peerId, port = 6881, numWant = 100, timeoutMs = 8000, signal, allowPrivate = false }) {
  const trackerPort = Number(u.port);
  if (!trackerPort) throw new Error('UDP tracker URL has no port');
  const host = (await resolvePublic(u.hostname, { allowPrivate })).find((r) => r.family === 4)?.address;
  if (!host) throw new Error('Tracker host is unresolvable or not public');

  const socket = dgram.createSocket('udp4');
  socket.unref();
  try {
    const roundTrip = (packet, expectedAction, transactionId) =>
      new Promise((resolve, reject) => {
        let timer;
        let attempts = 0;
        const cleanup = () => {
          clearTimeout(timer);
          socket.off('message', onMessage);
          socket.off('error', onError);
          signal?.removeEventListener('abort', onAbort);
        };
        const onMessage = (msg) => {
          if (msg.length < 8 || msg.readUInt32BE(4) !== transactionId) return;
          cleanup();
          const action = msg.readUInt32BE(0);
          if (action === ACTION_ERROR) {
            reject(new Error(`Tracker error: ${msg.subarray(8, 200).toString('utf8')}`));
          } else if (action !== expectedAction) {
            reject(new Error('Unexpected tracker response'));
          } else {
            resolve(msg);
          }
        };
        const onError = (err) => {
          cleanup();
          reject(err);
        };
        const onAbort = () => {
          cleanup();
          reject(signal.reason);
        };
        const send = () => {
          attempts++;
          socket.send(packet, trackerPort, host);
          // UDP is lossy: retry once before giving up.
          timer = setTimeout(() => {
            if (attempts < 2) send();
            else {
              cleanup();
              reject(new Error('Tracker timed out'));
            }
          }, timeoutMs / 2);
        };
        if (signal?.aborted) return onAbort();
        socket.on('message', onMessage);
        socket.on('error', onError);
        signal?.addEventListener('abort', onAbort, { once: true });
        send();
      });

    const connectTid = randomBytes(4).readUInt32BE(0);
    const connectPacket = Buffer.alloc(16);
    connectPacket.writeBigUInt64BE(UDP_PROTOCOL_ID, 0);
    connectPacket.writeUInt32BE(ACTION_CONNECT, 8);
    connectPacket.writeUInt32BE(connectTid, 12);
    const connectRes = await roundTrip(connectPacket, ACTION_CONNECT, connectTid);
    if (connectRes.length < 16) throw new Error('Short connect response');

    const announceTid = randomBytes(4).readUInt32BE(0);
    const packet = Buffer.alloc(98);
    connectRes.copy(packet, 0, 8, 16); // connection id
    packet.writeUInt32BE(ACTION_ANNOUNCE, 8);
    packet.writeUInt32BE(announceTid, 12);
    Buffer.from(infoHash).copy(packet, 16);
    Buffer.from(peerId).copy(packet, 36);
    packet.writeBigUInt64BE(0n, 56); // downloaded
    packet.writeBigUInt64BE(BigInt(LEFT), 64);
    packet.writeBigUInt64BE(0n, 72); // uploaded
    packet.writeUInt32BE(EVENT_STARTED, 80);
    packet.writeUInt32BE(0, 84); // ip: default
    randomBytes(4).copy(packet, 88); // key
    packet.writeInt32BE(numWant, 92);
    packet.writeUInt16BE(port, 96);
    const res = await roundTrip(packet, ACTION_ANNOUNCE, announceTid);
    if (res.length < 20) throw new Error('Short announce response');
    return filterPeers(parseCompactV4(res.subarray(20)), allowPrivate).map(formatPeer);
  } finally {
    socket.close();
  }
}

const percentEncode = (bytes) => Array.from(bytes, (b) => `%${b.toString(16).padStart(2, '0')}`).join('');

async function announceHttp(u, { infoHash, peerId, port = 6881, numWant = 100, timeoutMs = 8000, signal, allowPrivate = false }) {
  const [target] = await resolvePublic(u.hostname, { allowPrivate });
  if (!target) throw new Error('Tracker host is unresolvable or not public');
  u.hash = '';
  const query =
    `info_hash=${percentEncode(infoHash)}&peer_id=${percentEncode(peerId)}&port=${port}` +
    `&uploaded=0&downloaded=0&left=${LEFT}&compact=1&numwant=${numWant}&event=started`;
  const body = await pinnedGet(`${u.href}${u.search ? '&' : '?'}${query}`, {
    address: target.address,
    family: target.family,
    timeoutMs,
    maxBytes: MAX_HTTP_RESPONSE,
    signal,
    headers: { 'user-agent': `${APP_NAME}/${APP_VERSION}` },
  });
  const data = bencode.decode(body);
  if (data['failure reason']) {
    throw new Error(`Tracker error: ${Buffer.from(data['failure reason']).toString('utf8').slice(0, 200)}`);
  }
  const peers = [];
  if (data.peers instanceof Uint8Array) peers.push(...parseCompactV4(data.peers));
  else if (Array.isArray(data.peers)) {
    for (const p of data.peers) {
      if (p?.ip && Number.isInteger(p.port)) peers.push({ host: Buffer.from(p.ip).toString('utf8'), port: p.port });
    }
  }
  if (data.peers6 instanceof Uint8Array) peers.push(...parseCompactV6(data.peers6));
  return filterPeers(peers, allowPrivate).map(formatPeer);
}
