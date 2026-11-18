import { Composer } from 'grammy';
import * as texts from '../texts.js';

/**
 * Owner-only commands: /stats and /broadcast. Everyone else falls through to
 * the normal handlers, exactly as if these commands didn't exist.
 */
export function createAdmin({ config, stats, limiter, fetcher, store, broadcaster }) {
  const composer = new Composer();
  const owner = composer.filter((ctx) => Boolean(config.ownerId) && ctx.from?.id === config.ownerId);
  const html = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };

  owner.command('stats', (ctx) =>
    ctx.reply(
      texts.stats({
        startedAt: stats.startedAt,
        counters: stats.counters,
        limiter: limiter.stats,
        fetcher: fetcher.stats,
        db: store?.counts(),
        broadcast: broadcaster?.current,
        memory: process.memoryUsage(),
        username: ctx.me.username,
      }),
      html,
    ),
  );

  if (!store || !broadcaster) return composer;
  const ownerPrivate = owner.chatType('private');

  // Reply to any message with /broadcast → confirm → it's copied to everyone.
  ownerPrivate.command('broadcast', async (ctx) => {
    const source = ctx.msg.reply_to_message;
    if (!source) return ctx.reply(texts.broadcastUsage(), html);
    if (broadcaster.current) return ctx.reply(texts.broadcastBusy(broadcaster.current), html);
    const counts = store.counts();
    return ctx.reply(texts.broadcastConfirm(counts, config.broadcastRate), {
      ...html,
      reply_parameters: { message_id: source.message_id, allow_sending_without_reply: true },
      reply_markup: texts.broadcastConfirmKeyboard(source.message_id, counts),
    });
  });

  ownerPrivate.callbackQuery(/^bc:go:(users|all):(\d+)$/, async (ctx) => {
    // Check and start without awaiting in between, so a double tap can't start two.
    if (broadcaster.current) return ctx.answerCallbackQuery({ text: 'A broadcast is already running.' });
    const status = ctx.callbackQuery.message;
    const b = broadcaster.start({
      fromChatId: ctx.chat.id,
      messageId: Number(ctx.match[2]),
      audience: ctx.match[1],
      statusChatId: status?.chat.id,
      statusMessageId: status?.message_id,
    });
    await ctx.answerCallbackQuery({ text: 'Broadcast started' });
    await ctx.editMessageText(texts.broadcastProgress(b, 0), {
      ...html,
      reply_markup: texts.broadcastCancelKeyboard(b.id),
    });
  });

  ownerPrivate.callbackQuery('bc:no', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(texts.broadcastDiscarded(), html);
  });

  ownerPrivate.callbackQuery(/^bc:cancel:(\d+)$/, async (ctx) => {
    const cancelled = broadcaster.cancel(Number(ctx.match[1]));
    await ctx.answerCallbackQuery({ text: cancelled ? 'Cancelling…' : 'That broadcast is not running.' });
  });

  return composer;
}

export const OWNER_COMMANDS = [
  { command: 'stats', description: 'Bot statistics (owner)' },
  { command: 'broadcast', description: 'Reply to a message to send it to all users (owner)' },
];
