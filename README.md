# Torrent Converter

[![CI](https://github.com/JinsoRaj/TorrentConverter/actions/workflows/ci.yml/badge.svg)](https://github.com/JinsoRaj/TorrentConverter/actions/workflows/ci.yml)

A Telegram bot that converts **magnet links ⇄ .torrent files**. Works in private chats and groups.

Live: [@TorrentToMagnetRobot](https://t.me/TorrentToMagnetRobot)

## Features

- 🧲 **Magnet → torrent**: fetches the torrent's metadata straight from the BitTorrent network (DHT + trackers + peers) and sends back a `.torrent` file that includes the magnet's trackers and web seeds. Usually takes a few seconds.
- 📄 **Torrent → magnet**: send a `.torrent` file and get its magnet link, size, file count and info hash, with a one-tap copy button.
- 👥 **Groups**: messages that start with a magnet link are converted automatically. `/convert magnet:?…` and replying `/convert` to a magnet or a `.torrent` file work even when the bot can only see commands.
- ⏱ Live progress and a **Cancel** button while a magnet is being fetched, a fair queue when it's busy, and per-user limits.
- 📣 **Owner tools**: a small subscriber database, a rate-limit-safe **/broadcast** that resumes after restarts, **/stats**, and an optional **log channel** (new users, new groups, errors, broadcast reports).
- 🛡 Hardened: misbehaving peers, trackers and crafted .torrent files can't crash the bot or blow up its memory. It never connects to private/internal addresses from untrusted magnets, verifies all metadata, keeps the bot token out of logs, handles Telegram rate limits, and shuts down gracefully.
- 📦 Pure JavaScript: no native modules to compile, and a built-in SQLite database (no external DB server).

## Commands

| Command | What it does |
| --- | --- |
| `/start` | Welcome message and menu |
| `/help` | How to use the bot |
| `/convert` | `/convert magnet:?…`, or reply to a magnet link / `.torrent` file |
| `/about` | Version, developer and source code |
| `/stats` | *Owner only:* users, groups, conversions, DHT and memory stats |
| `/broadcast` | *Owner only:* reply to any message to copy it to all users (and optionally groups) |

## Requirements

- **Node.js 22.13 or newer** (Node 24 LTS recommended)
- A bot token from [@BotFather](https://t.me/BotFather)
- A server with normal outbound internet access (UDP + TCP), e.g. a small VPS. The bot typically uses 100-150 MB of RAM. The included pm2 config caps it (heap limit plus a graceful restart at 400 MB), so it shares a 1 GB server comfortably.

## Quick start

```bash
git clone https://github.com/JinsoRaj/TorrentConverter
cd TorrentConverter
cp .env.example .env   # then put your BOT_TOKEN (and OWNER_ID) in .env
npm ci
npm start
```

## Configuration

All settings live in `.env` (see [`.env.example`](.env.example)). Only `BOT_TOKEN` is required.

| Variable | Default | Description |
| --- | --- | --- |
| `BOT_TOKEN` | *required* | Bot token from @BotFather |
| `OWNER_ID` | | Your numeric Telegram user id (ask [@userinfobot](https://t.me/userinfobot)). Enables `/stats` and `/broadcast`. |
| `LOG_CHAT_ID` | | Chat id of a channel/group (e.g. `-1001234567890`) where the bot posts logs. Add the bot there as an admin. |
| `BROADCAST_RATE` | `20` | Broadcast speed in messages/second (1-30; Telegram allows about 30/s). |
| `METADATA_TIMEOUT` | `60` | Seconds to search for a magnet's metadata before giving up. |
| `MAX_CONCURRENT_JOBS` | `5` | Magnet lookups running at once; more wait in a queue. |
| `MAX_JOBS_PER_USER` | `2` | Conversions one user can have in progress. |
| `DHT_PORT` | `0` (random) | UDP port of the DHT node. A fixed, open port makes lookups faster. |
| `EXTRA_TRACKERS` | | Extra `udp://` / `http(s)://` trackers used to find peers (comma separated). |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |
| `DATA_DIR` | `data` | Where `bot.db` (subscribers) and the DHT cache are stored. |

> **Tip:** to find a channel's id, open it in [Telegram Web](https://web.telegram.org/a/). The number after `#` in the address bar (like `-1001234567890`) is its id.

## Deploying on a VPS with pm2

```bash
# Node.js 24 LTS (Ubuntu/Debian, via NodeSource)
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pm2

git clone https://github.com/JinsoRaj/TorrentConverter ~/bots/TorrentConverter
cd ~/bots/TorrentConverter
cp .env.example .env && nano .env
npm ci --omit=dev

pm2 start ecosystem.config.cjs   # starts the bot as "torrentconverter"
pm2 save
pm2 startup                      # run the command it prints, so the bot starts on boot
```

Useful commands: `pm2 logs torrentconverter`, `pm2 restart torrentconverter`, `pm2 status`.

> Run **only one instance** per bot token. Telegram rejects two bots polling at once (`409 Conflict`). The included pm2 config already does this.

### Updating

```bash
cd ~/bots/TorrentConverter
git pull
npm ci --omit=dev
pm2 restart torrentconverter
```

Restarts are graceful: running conversions tell users the bot is restarting, and a running broadcast pauses and **resumes automatically** without sending anything twice.

## Upgrading from v1

v2 is a drop-in upgrade. Your `.env` keeps working (`DETA_DB_TOKEN` is simply ignored), and `bot.js` is still the entry point. You do need **Node.js 22.13+**. On Node 18 the bot exits with a clear message.

```bash
node -v                       # if this is below v22.13, upgrade Node first:
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pm2@latest && pm2 update   # restart pm2's daemon on the new Node
```

If you installed Node with **nvm** instead: `nvm install 24 && nvm alias default 24 && npm install -g pm2 && pm2 update`.

Then pull v2, install, and replace the old pm2 process with the new config:

```bash
cd ~/bots/TorrentConverter
git pull
rm -rf node_modules && npm ci --omit=dev
pm2 delete <old-process-name>    # see `pm2 ls` for the name
pm2 start ecosystem.config.cjs && pm2 save
```

> The subscriber list starts empty because v1 didn't store users. People are added as soon as they use the bot again.

## Network notes

Torrent → magnet conversion happens entirely on the server, so it always works. Magnet → torrent needs the server to reach the BitTorrent network:

- Outbound **UDP** (DHT and UDP trackers) and **TCP** (peers) must be allowed. Most VPS providers allow this.
- Some ISPs (and a few hosts) throttle, filter or DNS-block BitTorrent traffic. The bot is built to cope: it uses several DHT bootstrap routers, remembers DHT nodes across restarts, falls back to an HTTP tracker, and gives up cleanly with a helpful message. For the best results, host it in a datacenter rather than on a home connection. If a host's DNS blocks tracker domains, point the server at a public resolver (for example `1.1.1.1`).
- Optional: set `DHT_PORT=6881` and open it (`sudo ufw allow 6881/udp`, plus your cloud provider's firewall) so other DHT nodes can reach the bot. Lookups get faster and more reliable.
- Your users only ever talk to Telegram. They never connect to the BitTorrent network themselves.
- Serverless platforms and free tiers that sleep aren't suitable: the bot needs a long-running process.

## Development

```bash
npm ci
npm test        # unit + integration tests (offline: fake Telegram API, local trackers and peers)
npm run lint
npm run dev     # restarts on file changes
```

```
bot.js                 entry point (Node version check)
src/main.js            startup, polling (grammY runner), graceful shutdown
src/bot.js             wires handlers together
src/handlers/          commands, conversions, owner tools, subscriber tracking
src/broadcast.js       paced, resumable broadcasts
src/texts.js           every user-facing message
src/lib/metadata.js    magnet → metadata via DHT, trackers and peers (BEP 5/9/10)
src/lib/trackers.js    minimal UDP (BEP 15) and HTTP tracker client
src/lib/torrent.js     .torrent parsing and building, magnet links
src/lib/db.js          SQLite subscriber database (node:sqlite)
```

## Credits

- [grammY](https://grammy.dev/) framework 💙
- [WebTorrent](https://webtorrent.io/) project libraries: `bittorrent-dht`, `bittorrent-protocol`, `ut_metadata`, `parse-torrent`
- Developers of [magnet2torrent-js](https://www.npmjs.com/package/magnet2torrent-js) and [torrent2magnet](https://www.npmjs.com/package/torrent2magnet), which powered v1 😍
- Bechilar parti for VPS 😌

## License

[MIT](LICENSE)
