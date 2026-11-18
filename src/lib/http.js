import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

export class ResponseTooLargeError extends Error {
  name = 'ResponseTooLargeError';
}

/**
 * Read a fetch() Response body into a Buffer, refusing to buffer more than
 * `maxBytes` (protects memory against huge or endless responses).
 * @param {Response} res
 * @param {number} maxBytes
 */
export async function readBodyCapped(res, maxBytes) {
  const declared = Number(res.headers.get('content-length'));
  if (declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new ResponseTooLargeError(`Response is larger than ${maxBytes} bytes`);
  }
  if (!res.body) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      // Leaving the loop early cancels the underlying stream.
      throw new ResponseTooLargeError(`Response is larger than ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * GET a URL while connecting *only* to an already-vetted IP address (no second
 * DNS lookup, so DNS rebinding can't redirect us to an internal address).
 * Redirects are not followed. Resolves with the body as a Buffer.
 * @param {string | URL} url
 * @param {{address: string, family: number, timeoutMs?: number, maxBytes?: number, signal?: AbortSignal, headers?: Record<string, string>}} options
 */
export function pinnedGet(url, { address, family, timeoutMs = 8000, maxBytes = 512 * 1024, signal, headers }) {
  const u = new URL(url);
  const client = u.protocol === 'https:' ? https : http;
  const lookup = (_hostname, options, callback) =>
    options?.all ? callback(null, [{ address, family }]) : callback(null, address, family);
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    };
    const req = client.get(
      u,
      {
        headers,
        lookup,
        signal,
        servername: net.isIP(u.hostname.replace(/^\[|\]$/g, '')) ? undefined : u.hostname,
      },
      (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return done(new Error(`HTTP ${res.statusCode}`));
        }
        if (Number(res.headers['content-length']) > maxBytes) {
          res.destroy();
          return done(new ResponseTooLargeError(`Response is larger than ${maxBytes} bytes`));
        }
        const chunks = [];
        let total = 0;
        res.on('data', (chunk) => {
          total += chunk.length;
          if (total > maxBytes) {
            res.destroy();
            done(new ResponseTooLargeError(`Response is larger than ${maxBytes} bytes`));
          } else chunks.push(chunk);
        });
        res.on('end', () => done(null, Buffer.concat(chunks)));
        res.on('error', (err) => done(err));
      },
    );
    const timer = setTimeout(() => req.destroy(new Error('Request timed out')), timeoutMs);
    req.on('error', (err) => done(err));
  });
}
