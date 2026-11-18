// Guards against the bot being used to reach private/internal networks.
// Peer addresses and tracker URLs come from untrusted magnets, DHT nodes and
// trackers, so anything that isn't a public unicast address is rejected.

import net from 'node:net';
import dns from 'node:dns/promises';

const blocked = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (incl. cloud metadata endpoints)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast (deprecated)
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
]) {
  blocked.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [
  ['::', 96], // unspecified + deprecated IPv4-compatible addresses (::a.b.c.d)
  ['::1', 128], // loopback
  ['64:ff9b::', 96], // NAT64: embeds an IPv4 address
  ['2002::', 16], // 6to4: embeds an IPv4 address
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard-only
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
]) {
  blocked.addSubnet(address, prefix, 'ipv6');
}

/** True only for globally routable unicast IP addresses. */
export function isPublicIp(ip) {
  if (typeof ip !== 'string') return false;
  const host = ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip;
  if (net.isIPv4(host)) return !blocked.check(host, 'ipv4');
  if (net.isIPv6(host)) {
    // IPv4-mapped (::ffff:a.b.c.d) -> judge the embedded IPv4 address.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(host);
    if (mapped) return isPublicIp(mapped[1]);
    return !blocked.check(host, 'ipv6');
  }
  return false;
}

/** Split "host:port" / "[v6]:port" into parts; returns null when malformed. */
export function parseHostPort(address) {
  if (typeof address !== 'string') return null;
  const m = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(address);
  if (!m) return null;
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return null;
  return { host: m[1], port };
}

// c-ares based resolver: unlike dns.lookup() it doesn't occupy libuv's small
// thread pool, so slow or black-holed tracker domains can't stall the process.
const resolver = new dns.Resolver({ timeout: 3000, tries: 2 });

/**
 * Resolve a hostname to its addresses. Returns [] when the name doesn't resolve
 * or resolves to *any* non-public address. Callers must connect to one of the
 * returned addresses (not the hostname) so DNS can't change the answer in
 * between (DNS rebinding). Set `allowPrivate` only in tests.
 * @returns {Promise<{address: string, family: number}[]>}
 */
export async function resolvePublic(hostname, { allowPrivate = false } = {}) {
  const host = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
  const family = net.isIP(host);
  if (family) return allowPrivate || isPublicIp(host) ? [{ address: host, family }] : [];
  if (!host || host.length > 253) return [];
  const [v4, v6] = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
  const records = [
    ...(v4.status === 'fulfilled' ? v4.value.map((address) => ({ address, family: 4 })) : []),
    ...(v6.status === 'fulfilled' ? v6.value.map((address) => ({ address, family: 6 })) : []),
  ];
  if (!allowPrivate && records.some((r) => !isPublicIp(r.address))) return [];
  return records;
}
