// Fetches torrent metadata (the `info` dictionary) for a magnet link straight
// from the BitTorrent network: peers are discovered through the DHT and
// trackers, and the metadata is downloaded from them with BEP 9 (ut_metadata).
//
// A single DHT node is kept warm for the lifetime of the process (and its
// routing table persisted to disk), which makes lookups take seconds instead of
// bootstrapping a fresh DHT for every request.

import net from 'node:net';
import path from 'node:path';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { Client as DHT } from 'bittorrent-dht';
import Protocol from 'bittorrent-protocol';
import utMetadata from 'ut_metadata';
import { isPublicIp, parseHostPort } from './address.js';
import { announceMany, isSupportedTracker } from './trackers.js';
import { infoHashOf } from './torrent.js';
import { LRUCache } from './lru.js';

// The classic routers alone are no longer reliable (some time out, some hand
// out poor node lists), so several independent ones are used.
export const DEFAULT_BOOTSTRAP = [
  'router.bittorrent.com:6881',
  'router.utorrent.com:6881',
  'dht.transmissionbt.com:6881',
  'dht.libtorrent.org:25401',
  'dht.aelitis.com:6881',
  'dht.anacrolix.link:42069',
  'router.bitcomet.com:6881',
];

// Long-lived public trackers, used *only to discover peers* (they're never
// written into generated .torrent files). The HTTP one is a fallback for
// networks that throttle or filter UDP.
export const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://explodie.org:6969/announce',
  'http://tracker.opentrackr.org:1337/announce',
];

const CONNECT_TIMEOUT_MS = 5_000;
const IDLE_TIMEOUT_MS = 15_000;
const DHT_RELOOKUP_MS = 15_000;
const TRACKER_REANNOUNCE_MS = 25_000;
const PROGRESS_INTERVAL_MS = 2_000;
const MAX_PEERS_PER_JOB = 3_000;
// Untrusted peers: bound what one connection (and one job) may cost us.
const HANDSHAKE_BYTES = 68;
const MAX_PEER_MESSAGE_BYTES = 256 * 1024; // ut_metadata pieces are 16 KiB; bitfields of 2M pieces fit
const MAX_PEER_BYTES = 16 * 1024 * 1024; // total received from one peer
export const MAX_METADATA_BYTES = 8 * 1024 * 1024; // largest `info` dictionary we accept
const JOB_METADATA_BUDGET = 16 * 1024 * 1024; // metadata buffers reserved across one job's peers
const MAX_TRACKERS_PER_JOB = 25;
const SAVED_NODES = 200;
const BOOTSTRAP_FROM_SAVED = 50;
const SAVE_INTERVAL_MS = 15 * 60_000;

export class MetadataTimeoutError extends Error {
  name = 'MetadataTimeoutError';
  constructor(stats) {
    super('Timed out fetching torrent metadata');
    this.stats = stats;
  }
}

/**
 * @typedef {object} Progress
 * @property {number} peers peers discovered so far
 * @property {number} connected peers we managed to connect to
 * @property {number} elapsedMs
 */

export class MetadataFetcher {
  #dht = null;
  #jobs = new Map();
  #cache;
  #peerId = Buffer.concat([Buffer.from('-TC2000-'), randomBytes(12)]);
  #saveTimer = null;
  #destroyed = false;

  /**
   * @param {object} options
   * @param {import('../logger.js').Logger} options.logger
   * @param {boolean} [options.dht] disable to skip the DHT (tests)
   * @param {number} [options.dhtPort] 0 = random
   * @param {string[]} [options.bootstrap]
   * @param {string[]} [options.trackers] extra trackers used for peer discovery
   * @param {string} [options.stateFile] where to persist DHT nodes
   * @param {number} [options.maxConnections] peer connections per job
   * @param {boolean} [options.allowPrivate] allow private addresses (tests only)
   */
  constructor({
    logger,
    dht = true,
    dhtPort = 0,
    bootstrap = DEFAULT_BOOTSTRAP,
    trackers = DEFAULT_TRACKERS,
    stateFile,
    maxConnections = 30,
    allowPrivate = false,
    cacheMaxBytes = 32 * 1024 * 1024,
  }) {
    this.logger = logger;
    this.useDht = dht;
    this.dhtPort = dhtPort;
    this.bootstrap = bootstrap;
    this.trackers = trackers.filter(isSupportedTracker);
    this.stateFile = stateFile;
    this.maxConnections = maxConnections;
    this.allowPrivate = allowPrivate;
    this.#cache = new LRUCache({ maxEntries: 1000, maxBytes: cacheMaxBytes });
  }

  async start({ readyTimeoutMs = 15_000 } = {}) {
    if (!this.useDht) return;
    const saved = await this.#loadNodes();
    const dht = new DHT({
      bootstrap: [...saved.slice(0, BOOTSTRAP_FROM_SAVED).map((n) => `${n.host}:${n.port}`), ...this.bootstrap],
    });
    this.#dht = dht;
    dht.on('warning', (err) => this.logger.debug(`DHT warning: ${err.message}`));
    dht.on('error', (err) => this.logger.error('DHT error', err));

    dht.listen(this.dhtPort);
    await once(dht, 'listening');
    this.logger.info(`DHT listening on UDP port ${dht.address().port} (${saved.length} saved nodes)`);

    // Don't block startup forever if the bootstrap routers are unreachable;
    // lookups still work and the routing table keeps filling in the background.
    let timer;
    await Promise.race([
      once(dht, 'ready').catch(() => {}),
      new Promise((resolve) => (timer = setTimeout(resolve, readyTimeoutMs))),
    ]);
    clearTimeout(timer);
    this.logger.info(`DHT ready with ${dht.toJSON().nodes.length} nodes`);

    this.#saveTimer = setInterval(() => this.#saveNodes(), SAVE_INTERVAL_MS);
    this.#saveTimer.unref();
  }

  /**
   * Get the raw `info` dictionary for a magnet.
   * @param {{infoHash: string, announce?: string[], peerAddresses?: string[]}} magnet
   * @param {{timeoutMs?: number, signal?: AbortSignal, onProgress?: (p: Progress) => void}} [options]
   * @returns {Promise<{info: Buffer, cached: boolean}>}
   */
  fetch(magnet, { timeoutMs = 60_000, signal, onProgress } = {}) {
    if (this.#destroyed) return Promise.reject(new Error('Fetcher is shut down'));
    const cached = this.#cache.get(magnet.infoHash);
    if (cached) return Promise.resolve({ info: cached, cached: true });

    // Requests for the same torrent share one network job.
    let job = this.#jobs.get(magnet.infoHash);
    if (!job) {
      job = new SharedJob((jobSignal, emit) => this.#fetchFromNetwork(magnet, { timeoutMs, signal: jobSignal, emit }));
      this.#jobs.set(magnet.infoHash, job);
      job.promise.then(
        (info) => this.#cache.set(magnet.infoHash, info),
        () => {},
      );
      job.promise.finally(() => this.#jobs.delete(magnet.infoHash)).catch(() => {});
    }
    return job.subscribe({ signal, onProgress }).then((info) => ({ info, cached: false }));
  }

  get stats() {
    return {
      dhtNodes: this.#dht ? this.#dht.toJSON().nodes.length : 0,
      activeLookups: this.#jobs.size,
      cachedTorrents: this.#cache.size,
    };
  }

  async destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    clearInterval(this.#saveTimer);
    for (const job of this.#jobs.values()) job.abort(new Error('Shutting down'));
    if (this.#dht) {
      await this.#saveNodes();
      await new Promise((resolve) => this.#dht.destroy(resolve));
      this.#dht = null;
    }
  }

  #fetchFromNetwork(magnet, { timeoutMs, signal, emit }) {
    const { infoHash } = magnet;
    const infoHashBuf = Buffer.from(infoHash, 'hex');
    const dht = this.#dht;
    const startedAt = Date.now();
    const stats = { peers: 0, connected: 0 };
    const seen = new Set();
    const queue = [];
    const sockets = new Set();
    const trackerAbort = new AbortController();
    // Configured trackers first, so a magnet listing dozens of trackers can't crowd them out.
    const trackers = [...new Set([...this.trackers, ...(magnet.announce ?? []).filter(isSupportedTracker)])].slice(
      0,
      MAX_TRACKERS_PER_JOB,
    );
    let metadataReserved = 0;

    return new Promise((resolve, reject) => {
      let finished = false;
      let abortLookup = null;
      let lookupTimer = null;
      let reannounceTimer = null;
      let addPeer = () => {};
      const onDhtPeer = (peer, hash) => {
        if (hash.toString('hex') === infoHash) addPeer(`${peer.host}:${peer.port}`);
      };

      const progress = () => emit({ ...stats, elapsedMs: Date.now() - startedAt });
      const progressTimer = setInterval(progress, PROGRESS_INTERVAL_MS);

      const finish = (err, info) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeoutTimer);
        clearTimeout(lookupTimer);
        clearTimeout(reannounceTimer);
        clearInterval(progressTimer);
        signal.removeEventListener('abort', onAbort);
        abortLookup?.();
        dht?.removeListener('peer', onDhtPeer);
        trackerAbort.abort();
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        queue.length = 0;
        const summary = `${infoHash} after ${Date.now() - startedAt}ms (${stats.peers} peers, ${stats.connected} connected)`;
        if (err) {
          this.logger.debug(`Metadata fetch failed for ${summary}: ${err.message}`);
          reject(err);
        } else {
          this.logger.debug(`Metadata fetched for ${summary}`);
          resolve(info);
        }
      };

      const timeoutTimer = setTimeout(() => finish(new MetadataTimeoutError({ ...stats })), timeoutMs);
      const onAbort = () => finish(signal.reason ?? new Error('Aborted'));
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });

      const pump = () => {
        while (!finished && sockets.size < this.maxConnections && queue.length) connect(queue.shift());
      };

      addPeer = (address) => {
        if (finished || seen.size >= MAX_PEERS_PER_JOB) return;
        const peer = parseHostPort(address);
        if (!peer || (!this.allowPrivate && !isPublicIp(peer.host))) return;
        const key = `${peer.host}|${peer.port}`;
        if (seen.has(key)) return;
        seen.add(key);
        stats.peers++;
        queue.push(peer);
        pump();
      };

      const connect = ({ host, port }) => {
        const socket = net.connect({ host, port });
        sockets.add(socket);
        socket.setTimeout(CONNECT_TIMEOUT_MS, () => socket.destroy());
        socket.on('error', () => {});
        socket.on('close', () => {
          sockets.delete(socket);
          pump();
        });
        socket.once('connect', () => {
          if (finished) return socket.destroy();
          stats.connected++;
          socket.setTimeout(IDLE_TIMEOUT_MS);
          guardPeerStream(socket);
          const wire = new Protocol();
          wire.on('error', () => socket.destroy());
          socket.on('close', () => wire.destroy());
          socket.pipe(wire).pipe(socket);

          wire.use(utMetadata());
          containExtension(wire.ut_metadata, socket, (size) => {
            // Each peer that claims to have the metadata makes ut_metadata allocate a
            // buffer of the size it announces: cap it, and cap the total per job.
            if (size > MAX_METADATA_BYTES || metadataReserved + size > JOB_METADATA_BUDGET) return false;
            metadataReserved += size;
            socket.once('close', () => (metadataReserved -= size));
            return true;
          });
          wire.on('handshake', (theirInfoHash) => {
            if (theirInfoHash !== infoHash) socket.destroy();
          });
          // Peers that run a DHT node tell us its port: grow our routing table.
          wire.on('port', (dhtPort) => {
            if (dht && !finished && dhtPort > 0) dht.addNode({ host, port: dhtPort });
          });
          wire.ut_metadata.on('warning', () => socket.destroy());
          wire.ut_metadata.on('metadata', () => {
            const raw = wire.ut_metadata.metadata;
            // ut_metadata already verifies, but never trust a peer: check the hash ourselves.
            if (raw && infoHashOf(raw) === infoHash) finish(null, Buffer.from(raw));
            else socket.destroy();
          });
          wire.ut_metadata.fetch();
          wire.handshake(infoHashBuf, this.#peerId, { dht: Boolean(dht) });
        });
      };

      // Magnets may carry peer addresses directly (BEP 9 "x.pe").
      for (const address of magnet.peerAddresses ?? []) addPeer(address);

      // DHT: look the torrent up now, then periodically while we're still searching.
      if (dht) {
        dht.on('peer', onDhtPeer);
        const lookup = () => {
          if (finished) return;
          abortLookup = dht.lookup(infoHash, () => {
            if (!finished) lookupTimer = setTimeout(lookup, DHT_RELOOKUP_MS);
          });
        };
        lookup();
      }

      // Trackers from the magnet plus a few public ones.
      const announceAll = () =>
        announceMany(
          trackers,
          { infoHash: infoHashBuf, peerId: this.#peerId, signal: trackerAbort.signal, allowPrivate: this.allowPrivate },
          {
            onPeers: (peers) => peers.forEach(addPeer),
            onError: (err, url) => this.logger.debug(`Tracker ${url}: ${err.message}`),
          },
        );
      if (trackers.length) {
        announceAll();
        reannounceTimer = setTimeout(announceAll, TRACKER_REANNOUNCE_MS);
      }
    });
  }

  async #loadNodes() {
    if (!this.stateFile) return [];
    try {
      const data = JSON.parse(await readFile(this.stateFile, 'utf8'));
      return (Array.isArray(data.nodes) ? data.nodes : []).filter(
        (n) => n && typeof n.host === 'string' && isPublicIp(n.host) && Number.isInteger(n.port) && n.port > 0 && n.port < 65536,
      );
    } catch (err) {
      if (err.code !== 'ENOENT') this.logger.warn(`Ignoring unreadable DHT state file: ${err.message}`);
      return [];
    }
  }

  async #saveNodes() {
    if (!this.stateFile || !this.#dht) return;
    try {
      const nodes = this.#dht
        .toJSON()
        .nodes.filter((n) => isPublicIp(n.host))
        .slice(0, SAVED_NODES)
        .map(({ host, port }) => ({ host, port }));
      if (!nodes.length) return;
      await mkdir(path.dirname(this.stateFile), { recursive: true });
      const tmp = `${this.stateFile}.tmp`;
      await writeFile(tmp, JSON.stringify({ savedAt: new Date().toISOString(), nodes }));
      await rename(tmp, this.stateFile);
    } catch (err) {
      this.logger.warn(`Could not save DHT state: ${err.message}`);
    }
  }
}

/**
 * Drop peers that send oversized messages or too much data in total.
 * bittorrent-protocol buffers each message whole (whatever length the peer
 * declares), so without this one peer could make us buffer gigabytes.
 */
function guardPeerStream(socket) {
  let total = 0;
  let handshakeLeft = HANDSHAKE_BYTES;
  let bodyLeft = 0;
  const header = Buffer.alloc(4);
  let headerFilled = 0;
  socket.on('data', (chunk) => {
    total += chunk.length;
    if (total > MAX_PEER_BYTES) return socket.destroy();
    let i = 0;
    while (i < chunk.length) {
      if (handshakeLeft > 0) {
        const n = Math.min(handshakeLeft, chunk.length - i);
        handshakeLeft -= n;
        i += n;
      } else if (bodyLeft > 0) {
        const n = Math.min(bodyLeft, chunk.length - i);
        bodyLeft -= n;
        i += n;
      } else {
        header[headerFilled++] = chunk[i++];
        if (headerFilled === 4) {
          headerFilled = 0;
          bodyLeft = header.readUInt32BE(0);
          if (bodyLeft > MAX_PEER_MESSAGE_BYTES) return socket.destroy();
        }
      }
    }
  });
}

/**
 * ut_metadata throws synchronously on some malformed peer messages, from inside
 * a stream callback where nothing catches it, which would crash the process.
 * Contain those failures to the one misbehaving peer.
 */
function containExtension(ext, socket, reserveMetadata) {
  const guard = (name, before) => {
    const original = ext[name]?.bind(ext);
    if (!original) return;
    ext[name] = (...args) => {
      try {
        if (before && before(...args) === false) return socket.destroy();
        const result = original(...args);
        if (result && typeof result.catch === 'function') result.catch(() => socket.destroy());
        return result;
      } catch {
        socket.destroy();
      }
    };
  };
  guard('onHandshake');
  guard('onExtendedHandshake', (handshake) => {
    const size = handshake?.metadata_size;
    if (typeof size !== 'number' || size <= 0) return true; // ut_metadata itself rejects these
    return reserveMetadata(size);
  });
  guard('onMessage');
  // Async verification step; a peer can make it reject (e.g. hash-matching garbage).
  guard('_checkDone');
}

/**
 * One network job shared by every caller asking for the same torrent.
 * The job is cancelled when all of its callers have gone away.
 */
class SharedJob {
  #controller = new AbortController();
  #listeners = new Set();
  #subscribers = 0;
  #settled = false;

  constructor(run) {
    this.promise = run(this.#controller.signal, (progress) => {
      for (const listener of this.#listeners) {
        try {
          listener(progress);
        } catch {
          // A broken progress listener must not break the job.
        }
      }
    });
    this.promise.then(
      () => (this.#settled = true),
      () => (this.#settled = true),
    );
  }

  abort(reason) {
    this.#controller.abort(reason);
  }

  subscribe({ signal, onProgress } = {}) {
    this.#subscribers++;
    if (onProgress) this.#listeners.add(onProgress);
    return new Promise((resolve, reject) => {
      let done = false;
      const leave = () => {
        if (done) return false;
        done = true;
        signal?.removeEventListener('abort', onAbort);
        if (onProgress) this.#listeners.delete(onProgress);
        if (--this.#subscribers === 0 && !this.#settled) this.#controller.abort(new Error('No callers left'));
        return true;
      };
      const onAbort = () => leave() && reject(signal.reason);
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      this.promise.then(
        (value) => leave() && resolve(value),
        (err) => leave() && reject(err),
      );
    });
  }
}
