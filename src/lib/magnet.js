// Finding and validating magnet links in user messages.

import parseTorrent from 'parse-torrent';

export class InvalidMagnetError extends Error {
  name = 'InvalidMagnetError';
}
export class UnsupportedMagnetError extends Error {
  name = 'UnsupportedMagnetError';
}

// A magnet runs until whitespace or a character that can't appear unescaped in a URI.
const MAGNET_RE = /magnet:\?[^\s<>"'`]+/gi;
const TRAILING_PUNCTUATION = /[).,;!?\]}>»”’]+$/;

/**
 * Pull magnet links out of free text (deduplicated, in order of appearance).
 * @param {string} text
 * @param {number} [limit]
 */
export function extractMagnets(text, limit = Infinity) {
  if (!text) return [];
  const found = [];
  for (const match of text.matchAll(MAGNET_RE)) {
    const uri = match[0].replace(TRAILING_PUNCTUATION, '');
    if (!found.includes(uri)) found.push(uri);
    if (found.length >= limit) break;
  }
  return found;
}

const MAX_TRACKERS = 200;

/**
 * Parse a magnet link.
 * @param {string} uri
 * @returns {Promise<{infoHash: string, infoHashV2?: string, name?: string, announce: string[], urlList: string[]}>}
 */
export async function parseMagnet(uri) {
  let parsed;
  try {
    parsed = await parseTorrent(uri);
  } catch (err) {
    if (/xt=urn:btmh:/i.test(uri) && !/xt=urn:btih:/i.test(uri)) {
      throw new UnsupportedMagnetError('BitTorrent v2-only magnets are not supported yet', { cause: err });
    }
    throw new InvalidMagnetError('Not a valid BitTorrent magnet link', { cause: err });
  }
  if (!/^[0-9a-f]{40}$/.test(parsed.infoHash ?? '')) {
    throw new InvalidMagnetError('Magnet link has no valid info hash');
  }
  const name = typeof parsed.name === 'string' ? parsed.name : Array.isArray(parsed.name) ? parsed.name[0] : undefined;
  const list = (v) => (Array.isArray(v) ? v : v ? [v] : []).filter((s) => typeof s === 'string');
  return {
    infoHash: parsed.infoHash,
    infoHashV2: parsed.infoHashV2,
    name: name?.trim() || undefined,
    announce: list(parsed.announce).slice(0, MAX_TRACKERS),
    urlList: list(parsed.urlList).slice(0, MAX_TRACKERS),
    peerAddresses: list(parsed.peerAddresses).slice(0, 50), // BEP 9 "x.pe"
  };
}
