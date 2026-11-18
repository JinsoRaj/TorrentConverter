// Torrent Converter: a Telegram bot that converts magnet links ⇄ .torrent files.
// (c) JinsoRaj · MIT · https://github.com/JinsoRaj/TorrentConverter
//
// This file stays the entry point so existing setups (`node bot.js`,
// `npm start`, `pm2 start bot.js`) keep working after upgrading.

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(
    `TorrentConverter v2 needs Node.js 22.13 or newer (Node 24 LTS recommended), but this is ${process.version}.\n` +
      'Upgrade Node.js (see "Upgrading from v1" in README.md) and start the bot again.',
  );
  process.exit(1);
}

// Node's built-in SQLite works fine but still prints an "experimental" notice
// on some versions; hide just that one warning.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...args) {
  if (String(warning?.message ?? warning).includes('SQLite is an experimental feature')) return;
  return emitWarning.call(this, warning, ...args);
};

// Plain dynamic import (no top-level await) so this file also loads when a
// process manager require()s it.
import('./src/main.js').catch((err) => {
  console.error('Failed to start TorrentConverter:', err);
  process.exit(1);
});
