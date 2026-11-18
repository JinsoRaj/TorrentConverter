// A minimal, allocation-light bencode *scanner*.
//
// It finds where values start and end without decoding them, which is used to:
//  - hash the original `info` bytes (re-encoding a decoded dictionary changes
//    the info hash for torrents whose encoder didn't sort keys), and
//  - read just the few fields we need from untrusted .torrent files without
//    building millions of objects for torrents with huge file lists.

const D = 0x64; // d
const L = 0x6c; // l
const I = 0x69; // i
const E = 0x65; // e
const COLON = 0x3a;
const MAX_DEPTH = 64;

export class BencodeError extends Error {
  name = 'BencodeError';
}

/** @typedef {{start: number, end: number}} Span  value bytes are buf[start, end) */

function readStringSpan(buf, pos) {
  const colon = buf.indexOf(COLON, pos);
  if (colon === -1 || colon === pos || colon - pos > 10) throw new BencodeError('Bad string length');
  let length = 0;
  for (let i = pos; i < colon; i++) {
    const digit = buf[i] - 0x30;
    if (digit < 0 || digit > 9) throw new BencodeError('Bad string length');
    length = length * 10 + digit;
  }
  const start = colon + 1;
  const end = start + length;
  if (end > buf.length) throw new BencodeError('String runs past end of data');
  return { start, end };
}

/** Index just past the bencoded value starting at `pos`. */
export function skipValue(buf, pos, depth = 0) {
  if (depth > MAX_DEPTH) throw new BencodeError('Bencode nesting too deep');
  const byte = buf[pos];
  if (byte === I) {
    const end = buf.indexOf(E, pos + 1);
    if (end === -1) throw new BencodeError('Unterminated integer');
    return end + 1;
  }
  if (byte === L || byte === D) {
    let p = pos + 1;
    while (buf[p] !== E) {
      if (p >= buf.length) throw new BencodeError('Unterminated list/dict');
      if (byte === D) p = readStringSpan(buf, p).end;
      p = skipValue(buf, p, depth + 1);
    }
    return p + 1;
  }
  if (byte >= 0x30 && byte <= 0x39) return readStringSpan(buf, pos).end;
  throw new BencodeError(`Unexpected byte at ${pos}`);
}

/** Span of the whole value starting at `pos`. */
export const spanAt = (buf, pos) => ({ start: pos, end: skipValue(buf, pos) });

/**
 * Map of key → value span for the dictionary starting at `pos`.
 * @returns {Map<string, Span>}
 */
export function dictEntries(buf, pos = 0) {
  if (buf[pos] !== D) throw new BencodeError('Expected a dictionary');
  const entries = new Map();
  let p = pos + 1;
  while (buf[p] !== E) {
    if (p >= buf.length) throw new BencodeError('Unterminated dictionary');
    const key = readStringSpan(buf, p);
    const end = skipValue(buf, key.end);
    entries.set(Buffer.from(buf.buffer, buf.byteOffset + key.start, key.end - key.start).toString('latin1'), {
      start: key.end,
      end,
    });
    p = end;
  }
  return entries;
}

/** Find one key in the dictionary at `pos` without building a map. */
export function dictGet(buf, pos, wanted) {
  if (buf[pos] !== D) throw new BencodeError('Expected a dictionary');
  let p = pos + 1;
  while (buf[p] !== E) {
    if (p >= buf.length) throw new BencodeError('Unterminated dictionary');
    const key = readStringSpan(buf, p);
    const end = skipValue(buf, key.end);
    if (key.end - key.start === wanted.length) {
      let same = true;
      for (let i = 0; i < wanted.length; i++) {
        if (buf[key.start + i] !== wanted.charCodeAt(i)) {
          same = false;
          break;
        }
      }
      if (same) return { start: key.end, end };
    }
    p = end;
  }
  return undefined;
}

/** Call `fn(span)` for every item of the list at `span`. */
export function forEachListItem(buf, span, fn) {
  if (buf[span.start] !== L) throw new BencodeError('Expected a list');
  let p = span.start + 1;
  while (buf[p] !== E) {
    if (p >= span.end) throw new BencodeError('Unterminated list');
    const end = skipValue(buf, p);
    fn({ start: p, end });
    p = end;
  }
}

export const isDict = (buf, span) => buf[span.start] === D;
export const isList = (buf, span) => buf[span.start] === L;
export const isInteger = (buf, span) => buf[span.start] === I;
export const isString = (buf, span) => buf[span.start] >= 0x30 && buf[span.start] <= 0x39;

/** Read an integer value (returns NaN when it's not a valid integer). */
export function readInteger(buf, span) {
  if (!isInteger(buf, span)) return NaN;
  const text = Buffer.from(buf.buffer, buf.byteOffset + span.start + 1, span.end - span.start - 2).toString('latin1');
  return /^(0|-?[1-9]\d*)$/.test(text) ? Number(text) : NaN;
}

/** Bytes of a string value (a view, not a copy), or undefined if it's not a string. */
export function readBytes(buf, span) {
  if (!isString(buf, span)) return undefined;
  const { start, end } = readStringSpan(buf, span.start);
  return buf.subarray(start, end);
}

/**
 * Find the raw `info` dictionary inside a .torrent file.
 * @param {Uint8Array} buf
 * @returns {Uint8Array} a view of the original bytes
 */
export function extractRawInfo(buf) {
  if (buf[0] !== D) throw new BencodeError('Torrent file is not a bencoded dictionary');
  const span = dictGet(buf, 0, 'info');
  if (!span) throw new BencodeError('Torrent file has no `info` dictionary');
  if (!isDict(buf, span)) throw new BencodeError('`info` is not a dictionary');
  return buf.subarray(span.start, span.end);
}
