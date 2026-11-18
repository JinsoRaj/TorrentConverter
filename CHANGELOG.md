# Changelog

## 2.0.0 (2026-11-18)

A ground-up rewrite on current Node.js and grammY. Existing `.env` files and `bot.js`/`npm start` setups keep working; **Node.js 22.13+ is now required**.

### Fixed (bugs in v1)

- **Magnet → torrent failed most of the time.** v1 started a brand-new DHT node for every request, relied on bootstrap routers that no longer respond reliably, ignored the magnet's own trackers and gave up after 20 seconds. v2 keeps one warm DHT node (remembered across restarts), uses several bootstrap routers, asks the magnet's trackers plus well-known public ones, and allows 60 seconds (configurable). Typical conversions now take 2-5 seconds.
- Generated `.torrent` files contained **no trackers**. They now include the magnet's trackers and web seeds.
- Info hashes are computed from the original bytes. Torrents written by non-standard encoders used to get a wrong hash and magnet.
- Text that wasn't a magnet still started a (failing) metadata fetch after replying "❌".
- In groups the *whole message* was used as the magnet, so any extra text broke it. Only one magnet per message worked, and magnets in the middle of a private message were ignored.
- `/command@SomeOtherBot magnet:?…` in groups triggered this bot too.
- `.torrent` files sent as `application/octet-stream` (common on desktop and Android) were ignored.
- Many API calls weren't awaited, so Telegram errors became unhandled promise rejections, which crash Node 15+. For example, a user deleting their message before the reply arrived could take the bot down.
- Errors were sent to users verbatim, and the bot-token-bearing file URL was handed to a third-party library. Users now get friendly messages, and the token never reaches logs.
- Magnet links weren't HTML-escaped (torrent names containing `<` or `&` broke replies), and magnets over 4096 characters couldn't be sent at all.
- The "add me to a group" link was hard-coded to the original bot's username.
- Implicit global variables, deprecated Bot API parameters, and 23 known vulnerabilities in dependencies (`request`, `ws`, `ip`, `validator`, …) are gone. `npm audit` now reports 0.
- No native modules: v1 compiled `deasync` with node-gyp during install.

### Added

- Live progress (peers found/connected, elapsed time) and a **Cancel** button while fetching.
- Fair queueing (`MAX_CONCURRENT_JOBS`) and per-user limits (`MAX_JOBS_PER_USER`).
- Up to 5 magnet links per message, `/convert` (including as a reply), captions with magnets.
- Rich results: name, size, file count, info hash, tracker count, private-torrent notice, tap-to-copy magnet and a copy button. Very long magnets are attached as a file.
- Friendlier `/start` menu with inline navigation, a command menu in Telegram, and a greeting when added to a group.
- **Subscriber database** (built-in SQLite, `data/bot.db`): users and groups, including who blocked the bot or removed it.
- **/broadcast** (owner): reply to any message to copy it to all users (and optionally groups). Paced under Telegram's limits, honours `retry_after`, skips and remembers unreachable users, can be stopped, and resumes after a restart without double-sending.
- **/stats** (owner) and an optional **log channel** (`LOG_CHAT_ID`) with batched `#NewUser`, `#NewGroup`, `#LeftGroup`, `#Error` and broadcast reports.
- Hardening against hostile input: malformed peer messages can't crash the process, per-peer and per-job memory limits, .torrent files parsed without decoding their file lists (a crafted 19 MB file uses about 6 MB instead of 1.7 GB), no connections to private/internal networks from untrusted magnets/trackers (DNS-rebinding safe), metadata verified against the info hash, and response size limits.
- Runs in about 100-150 MB of RAM. The pm2 config caps the heap and restarts gracefully at 400 MB.
- If polling stops for good (token revoked, or a second instance using the same token), the bot exits with a clear message so pm2 restarts it instead of it sitting idle.
- pm2 `ecosystem.config.cjs`, ESLint, 51 automated tests, GitHub Actions CI.

### Removed

- `DETA_DB_TOKEN` (Deta has shut down; it was never used).
