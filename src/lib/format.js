// Small, dependency-free formatting helpers used across the bot.

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

/** Escape a string for Telegram's HTML parse mode. */
export function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (ch) => HTML_ESCAPES[ch]);
}

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];

/** 1536 -> "1.5 KiB" (binary units, like most torrent clients). */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

/** 93784 -> "1d 2h 3m" */
export function formatDuration(ms) {
  const totalMinutes = Math.floor(ms / 60_000);
  const d = Math.floor(totalMinutes / 1440);
  const h = Math.floor((totalMinutes % 1440) / 60);
  const m = totalMinutes % 60;
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${Math.floor(ms / 1000)}s`;
}

/** Truncate to `max` characters (code points), adding an ellipsis when cut. */
export function truncate(value, max) {
  const chars = Array.from(String(value));
  if (chars.length <= max) return chars.join('');
  return chars.slice(0, Math.max(0, max - 1)).join('') + '…';
}

export function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count.toLocaleString('en-US')} ${count === 1 ? singular : pluralForm}`;
}

/**
 * Make a torrent name safe to use as a file name on every OS
 * (Telegram passes the name straight to the user's device).
 */
export function sanitizeFilename(name, fallback = 'download') {
  const cleaned = String(name ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '');
  return truncate(cleaned || fallback, 150);
}
