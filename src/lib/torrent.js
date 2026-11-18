// .torrent <-> magnet helpers.

import { createHash } from 'node:crypto';
import bencode from 'bencode';
import {
  BencodeError,
  dictEntries,
  dictGet,
  forEachListItem,
  isDict,
  readBytes,
  readInteger,
} from './bencode-raw.js';
import { APP_NAME, APP_VERSION } from '../version.js';

export class InvalidTorrentError extends Error {
  name = 'InvalidTorrentError';
}
export class UnsupportedTorrentError extends Error {
  name = 'UnsupportedTorrentError';
}

const sha1 = (bytes) => createHash('sha1').update(bytes).digest('hex');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const unique = (list) => [...new Set(list.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim()))];

function decodeSafe(bytes) {
  try {
    return bencode.decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Build a magnet URI. Values are percent-encoded so any client can read them.
 * @param {{infoHash: string, infoHashV2?: string, name?: string, length?: number, announce?: string[], urlList?: string[]}} t
 * @param {{trackers?: boolean}} [options] set `trackers: false` for a short, tracker-less magnet
 */
export function buildMagnet(t, { trackers = true } = {}) {
  const parts = [`xt=urn:btih:${t.infoHash}`];
  if (t.infoHashV2) parts.push(`xt=urn:btmh:1220${t.infoHashV2}`);
  if (t.name) parts.push(`dn=${encodeURIComponent(t.name)}`);
  if (Number.isSafeInteger(t.length) && t.length > 0) parts.push(`xl=${t.length}`);
  if (trackers) {
    for (const tr of unique(t.announce ?? [])) parts.push(`tr=${encodeURIComponent(tr)}`);
    for (const ws of unique(t.urlList ?? [])) parts.push(`ws=${encodeURIComponent(ws)}`);
  }
  return `magnet:?${parts.join('&')}`;
}

const MAX_TRACKERS = 200;
const MAX_LIST_BYTES = 512 * 1024; // announce-list / url-list larger than this are ignored

const text = (bytes) => (bytes ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).toString('utf8') : undefined);

/** Decode a small value (tracker lists etc.); oversized or broken values are ignored. */
function decodeSmall(buf, span) {
  if (!span || span.end - span.start > MAX_LIST_BYTES) return undefined;
  return decodeSafe(buf.subarray(span.start, span.end));
}

function stringList(value) {
  const out = [];
  const visit = (v, depth) => {
    if (v instanceof Uint8Array) out.push(text(v));
    else if (Array.isArray(v) && depth < 2) v.forEach((x) => visit(x, depth + 1));
  };
  visit(value, 0);
  return out;
}

/**
 * Parse a .torrent file and summarise it.
 *
 * Only the fields we show are read, straight from the raw bytes: the file list
 * is scanned rather than decoded, so even a torrent listing millions of files
 * costs no more memory than the file itself. The info hash is computed from
 * the original `info` bytes, so it always matches what BitTorrent clients use.
 * @param {Uint8Array} input
 */
export async function summarizeTorrent(input) {
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
  try {
    const top = dictEntries(buf, 0);
    const infoSpan = top.get('info');
    if (!infoSpan || !isDict(buf, infoSpan)) throw new InvalidTorrentError('Torrent file has no `info` dictionary');
    const rawInfo = buf.subarray(infoSpan.start, infoSpan.end);
    const info = dictEntries(rawInfo, 0);
    const int = (key) => (info.has(key) ? readInteger(rawInfo, info.get(key)) : undefined);
    const str = (key) => (info.has(key) ? text(readBytes(rawInfo, info.get(key))) : undefined);

    const isV2 = int('meta version') === 2;
    const pieces = info.has('pieces') ? readBytes(rawInfo, info.get('pieces')) : undefined;
    if (!pieces) {
      if (isV2) throw new UnsupportedTorrentError('BitTorrent v2-only torrents are not supported yet');
      throw new InvalidTorrentError('Missing `pieces`');
    }
    if (pieces.length % 20 !== 0) throw new InvalidTorrentError('Malformed `pieces`');
    const pieceLength = int('piece length');
    if (!(pieceLength > 0)) throw new InvalidTorrentError('Missing `piece length`');
    const name = str('name.utf-8') ?? str('name');
    if (name === undefined) throw new InvalidTorrentError('Missing `name`');

    let length = 0;
    let fileCount = 0;
    const files = info.get('files');
    if (files) {
      forEachListItem(rawInfo, files, (item) => {
        if (!isDict(rawInfo, item)) throw new InvalidTorrentError('Malformed file entry');
        const lengthSpan = dictGet(rawInfo, item.start, 'length');
        const size = lengthSpan ? readInteger(rawInfo, lengthSpan) : NaN;
        if (!Number.isSafeInteger(size) || size < 0) throw new InvalidTorrentError('Malformed file length');
        // Skip BEP 47 padding files: clients don't show them.
        const attr = dictGet(rawInfo, item.start, 'attr');
        if (attr && text(readBytes(rawInfo, attr))?.includes('p')) return;
        length += size;
        fileCount++;
      });
    } else {
      length = int('length');
      if (!Number.isSafeInteger(length) || length < 0) throw new InvalidTorrentError('Missing `length`');
      fileCount = 1;
    }

    const announce = unique([
      ...stringList(decodeSmall(buf, top.get('announce-list'))),
      ...stringList(decodeSmall(buf, top.get('announce'))),
    ]).slice(0, MAX_TRACKERS);
    const urlList = unique(stringList(decodeSmall(buf, top.get('url-list')))).slice(0, MAX_TRACKERS);

    const summary = {
      name: name.trim() || 'Unnamed torrent',
      infoHash: sha1(rawInfo),
      infoHashV2: isV2 ? sha256(rawInfo) : undefined,
      length,
      fileCount,
      pieceLength,
      private: int('private') === 1,
      announce,
      urlList,
    };
    summary.magnet = buildMagnet(summary);
    return summary;
  } catch (err) {
    if (err instanceof InvalidTorrentError || err instanceof UnsupportedTorrentError) throw err;
    if (err instanceof BencodeError) throw new InvalidTorrentError(err.message, { cause: err });
    throw err;
  }
}

/**
 * Assemble a .torrent file around raw `info` bytes fetched from peers.
 * The info bytes are spliced in verbatim so the info hash is preserved exactly.
 * @param {Uint8Array} rawInfo
 * @param {{announce?: string[], urlList?: string[]}} [extra] trackers/web seeds from the magnet
 */
export function buildTorrentFile(rawInfo, { announce = [], urlList = [] } = {}) {
  const trackers = unique(announce);
  const webSeeds = unique(urlList);

  // Bencoded dictionaries need sorted keys:
  // announce < announce-list < created by < creation date < info < url-list
  const head = {};
  if (trackers.length) {
    head.announce = trackers[0];
    head['announce-list'] = trackers.map((tr) => [tr]);
  }
  head['created by'] = `${APP_NAME}/${APP_VERSION}`;
  head['creation date'] = Math.floor(Date.now() / 1000);
  const tail = webSeeds.length ? { 'url-list': webSeeds } : {};

  const headBytes = bencode.encode(head); // "d…e"
  const tailBytes = bencode.encode(tail); // "d…e"
  return Buffer.concat([
    headBytes.subarray(0, -1), // drop closing "e"
    Buffer.from('4:info'),
    rawInfo,
    tailBytes.subarray(1), // drop opening "d", keep closing "e"
  ]);
}

/** SHA-1 of raw info bytes, as lowercase hex. */
export const infoHashOf = sha1;
