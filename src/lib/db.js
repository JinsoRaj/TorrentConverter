// A small SQLite database (Node's built-in `node:sqlite`, no native modules)
// that remembers who uses the bot, so the owner can broadcast to them.
// Everything lives in one file: data/bot.db (back it up by copying it).

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_VERSION = 1;

const MIGRATIONS = {
  1: `
    CREATE TABLE users (
      id            INTEGER PRIMARY KEY,   -- Telegram user id
      first_name    TEXT,
      username      TEXT,
      language_code TEXT,
      started_at    INTEGER NOT NULL,      -- unix ms, first seen
      last_seen_at  INTEGER NOT NULL,
      blocked_at    INTEGER                -- set when they block the bot / delete their account
    );
    CREATE TABLE chats (
      id           INTEGER PRIMARY KEY,    -- group / supergroup id
      type         TEXT NOT NULL,
      title        TEXT,
      username     TEXT,
      added_at     INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      left_at      INTEGER                 -- set when the bot is removed
    );
    CREATE TABLE broadcasts (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      from_chat_id      INTEGER NOT NULL,  -- message to copy
      message_id        INTEGER NOT NULL,
      audience          TEXT NOT NULL,     -- 'users' | 'all'
      status            TEXT NOT NULL,     -- 'running' | 'done' | 'cancelled' | 'failed'
      phase             TEXT NOT NULL,     -- 'users' | 'chats': where the cursor is
      cursor_id         INTEGER,           -- last processed id within the phase
      total             INTEGER NOT NULL,
      sent              INTEGER NOT NULL DEFAULT 0,
      failed            INTEGER NOT NULL DEFAULT 0,
      unreachable       INTEGER NOT NULL DEFAULT 0,
      error             TEXT,
      status_chat_id    INTEGER,           -- progress message shown to the owner
      status_message_id INTEGER,
      created_at        INTEGER NOT NULL,
      finished_at       INTEGER
    );
  `,
};

export class Store {
  /** @param {string} file path to the database, or ':memory:' */
  constructor(file) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
    this.#migrate();
    this.#prepare();
  }

  #migrate() {
    const current = this.db.prepare('PRAGMA user_version').get().user_version;
    for (let version = current + 1; version <= SCHEMA_VERSION; version++) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(MIGRATIONS[version]);
        this.db.exec(`PRAGMA user_version = ${version}`);
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    }
  }

  #prepare() {
    const q = (sql) => this.db.prepare(sql);
    this.s = {
      insertUser: q(`INSERT OR IGNORE INTO users (id, first_name, username, language_code, started_at, last_seen_at)
                     VALUES (?, ?, ?, ?, ?, ?)`),
      touchUser: q(`UPDATE users SET first_name = ?, username = ?, language_code = ?, last_seen_at = ?, blocked_at = NULL
                    WHERE id = ?`),
      setUserBlocked: q('UPDATE users SET blocked_at = ? WHERE id = ?'),
      insertChat: q(`INSERT OR IGNORE INTO chats (id, type, title, username, added_at, last_seen_at)
                     VALUES (?, ?, ?, ?, ?, ?)`),
      touchChat: q('UPDATE chats SET type = ?, title = ?, username = ?, last_seen_at = ?, left_at = NULL WHERE id = ?'),
      setChatLeft: q('UPDATE chats SET left_at = ? WHERE id = ?'),
      counts: q(`SELECT
                   (SELECT COUNT(*) FROM users) AS users,
                   (SELECT COUNT(*) FROM users WHERE blocked_at IS NULL) AS activeUsers,
                   (SELECT COUNT(*) FROM users WHERE started_at >= ?) AS newUsers24h,
                   (SELECT COUNT(*) FROM users WHERE last_seen_at >= ?) AS activeUsers24h,
                   (SELECT COUNT(*) FROM chats) AS chats,
                   (SELECT COUNT(*) FROM chats WHERE left_at IS NULL) AS activeChats`),
      nextUsers: q('SELECT id FROM users WHERE blocked_at IS NULL AND id > ? ORDER BY id LIMIT ?'),
      nextChats: q('SELECT id FROM chats WHERE left_at IS NULL AND id > ? ORDER BY id LIMIT ?'),
      createBroadcast: q(`INSERT INTO broadcasts (from_chat_id, message_id, audience, status, phase, total,
                            status_chat_id, status_message_id, created_at)
                          VALUES (?, ?, ?, 'running', 'users', ?, ?, ?, ?)`),
      getBroadcast: q('SELECT * FROM broadcasts WHERE id = ?'),
      runningBroadcasts: q("SELECT * FROM broadcasts WHERE status = 'running' ORDER BY id"),
      saveProgress: q(`UPDATE broadcasts SET phase = ?, cursor_id = ?, sent = ?, failed = ?, unreachable = ?
                       WHERE id = ?`),
      finishBroadcast: q('UPDATE broadcasts SET status = ?, error = ?, finished_at = ? WHERE id = ?'),
    };
  }

  /**
   * Record that a user talked to the bot. Returns true if they're new.
   * @param {{id: number, first_name?: string, username?: string, language_code?: string}} user
   */
  saveUser(user, now = Date.now()) {
    const fields = [user.first_name ?? null, user.username ?? null, user.language_code ?? null];
    const inserted = this.s.insertUser.run(user.id, ...fields, now, now).changes === 1;
    if (!inserted) this.s.touchUser.run(...fields, now, user.id);
    return inserted;
  }

  /** The user blocked the bot (or unblocked it: `blocked = false`). */
  setUserBlocked(userId, blocked = true, now = Date.now()) {
    this.s.setUserBlocked.run(blocked ? now : null, userId);
  }

  /** Record a group the bot is in. Returns true if it's new. */
  saveChat(chat, now = Date.now()) {
    const fields = [chat.type, chat.title ?? null, chat.username ?? null];
    const inserted = this.s.insertChat.run(chat.id, ...fields, now, now).changes === 1;
    if (!inserted) this.s.touchChat.run(...fields, now, chat.id);
    return inserted;
  }

  setChatLeft(chatId, now = Date.now()) {
    this.s.setChatLeft.run(now, chatId);
  }

  counts(now = Date.now()) {
    const dayAgo = now - 24 * 60 * 60 * 1000;
    return { ...this.s.counts.get(dayAgo, dayAgo) };
  }

  /** Next batch of broadcast targets after `cursorId` (ids ascending). */
  nextTargets(phase, cursorId, limit = 200) {
    const stmt = phase === 'users' ? this.s.nextUsers : this.s.nextChats;
    return stmt.all(cursorId ?? Number.MIN_SAFE_INTEGER, limit).map((row) => row.id);
  }

  createBroadcast({ fromChatId, messageId, audience, total, statusChatId, statusMessageId }, now = Date.now()) {
    const { lastInsertRowid } = this.s.createBroadcast.run(
      fromChatId,
      messageId,
      audience,
      total,
      statusChatId ?? null,
      statusMessageId ?? null,
      now,
    );
    return this.getBroadcast(Number(lastInsertRowid));
  }

  getBroadcast(id) {
    const row = this.s.getBroadcast.get(id);
    return row ? { ...row } : undefined;
  }

  runningBroadcasts() {
    return this.s.runningBroadcasts.all().map((row) => ({ ...row }));
  }

  saveBroadcastProgress(b) {
    this.s.saveProgress.run(b.phase, b.cursor_id ?? null, b.sent, b.failed, b.unreachable, b.id);
  }

  finishBroadcast(id, status, error = null, now = Date.now()) {
    this.s.finishBroadcast.run(status, error, now, id);
  }

  close() {
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }
}
