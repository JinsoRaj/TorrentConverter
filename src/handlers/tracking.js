import { Composer } from 'grammy';
import * as texts from '../texts.js';

const TOUCH_EVERY_MS = 10 * 60_000; // don't rewrite the same row more often than this
const MAX_REMEMBERED = 100_000;

/**
 * Keeps the subscriber database up to date:
 *  - users who talk to the bot in private (and whether they blocked it),
 *  - groups the bot is in (and whether it was removed).
 * Database problems are logged but never break the bot.
 */
export function createTracker({ store, logChannel, logger }) {
  const composer = new Composer();
  const lastWrite = new Map();

  const due = (key) => {
    const now = Date.now();
    const last = lastWrite.get(key);
    if (last && now - last < TOUCH_EVERY_MS) return false;
    if (lastWrite.size >= MAX_REMEMBERED) lastWrite.clear();
    lastWrite.set(key, now);
    return true;
  };
  const guard = (fn) => {
    try {
      fn();
    } catch (err) {
      logger.warn(`Database write failed: ${err.message}`);
    }
  };

  composer.use((ctx, next) => {
    const { chat, from } = ctx;
    if (!chat || ctx.myChatMember) return next(); // membership changes are handled below
    if (chat.type === 'private' && from && !from.is_bot && due(`u${from.id}`)) {
      guard(() => {
        if (store.saveUser(from)) {
          logger.debug(`New user ${from.id}`);
          logChannel.send(texts.logNewUser(from));
        }
      });
    } else if ((chat.type === 'group' || chat.type === 'supergroup') && due(`c${chat.id}`)) {
      // Groups that added the bot before the database existed are picked up here.
      guard(() => store.saveChat(chat));
    }
    return next();
  });

  composer.on('my_chat_member', (ctx, next) => {
    const { chat, from, old_chat_member: before, new_chat_member: after } = ctx.myChatMember;
    const wasIn = ['member', 'administrator', 'creator', 'restricted'].includes(before.status);
    const isIn = ['member', 'administrator', 'creator', 'restricted'].includes(after.status);
    guard(() => {
      if (chat.type === 'private') {
        if (after.status === 'kicked') {
          store.setUserBlocked(chat.id, true);
          lastWrite.delete(`u${chat.id}`);
        } else if (isIn) {
          store.saveUser(from); // unblocked / restarted: active again
          lastWrite.set(`u${chat.id}`, Date.now());
        }
      } else if (chat.type === 'group' || chat.type === 'supergroup') {
        if (!wasIn && isIn) {
          store.saveChat(chat);
          logChannel.send(texts.logAddedToGroup(chat, from));
        } else if (wasIn && !isIn) {
          store.setChatLeft(chat.id);
          lastWrite.delete(`c${chat.id}`);
          logChannel.send(texts.logRemovedFromGroup(chat, from));
        }
      }
    });
    return next();
  });

  return composer;
}
