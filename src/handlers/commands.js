import { Composer, GrammyError } from 'grammy';
import * as texts from '../texts.js';

const isPrivate = (ctx) => ctx.chat?.type === 'private';

/** In groups, quote the command so it's clear who the answer is for. */
const replyOptions = (ctx, extra = {}) => ({
  parse_mode: 'HTML',
  link_preview_options: { is_disabled: true },
  ...(isPrivate(ctx) ? {} : { reply_parameters: { message_id: ctx.msg.message_id, allow_sending_without_reply: true } }),
  ...extra,
});

/** /start, /help, /about and the inline menu. */
export function createCommands({ config }) {
  const composer = new Composer();
  const helpText = () =>
    texts.help({ timeoutSeconds: Math.round(config.metadataTimeoutMs / 1000), maxMagnets: config.maxMagnetsPerMessage });

  composer.command('start', (ctx) =>
    ctx.reply(texts.welcome(ctx.from), replyOptions(ctx, { reply_markup: texts.startKeyboard(ctx.me.username) })),
  );

  composer.command('help', (ctx) => ctx.reply(helpText(), replyOptions(ctx)));

  composer.command('about', (ctx) =>
    ctx.reply(texts.about(), replyOptions(ctx, { reply_markup: texts.aboutKeyboard(ctx.me.username) })),
  );

  // Inline menu: edit the message in place instead of sending new ones.
  const showMenu = (text, keyboard) => async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText(text(ctx), {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: keyboard(ctx),
      });
    } catch (err) {
      if (!(err instanceof GrammyError && /message is not modified/i.test(err.description))) throw err;
    }
  };
  composer.callbackQuery(
    'menu:start',
    showMenu(
      (ctx) => texts.welcome(ctx.from),
      (ctx) => texts.startKeyboard(ctx.me.username),
    ),
  );
  composer.callbackQuery('menu:help', showMenu(helpText, texts.backKeyboard));
  composer.callbackQuery(
    'menu:about',
    showMenu(texts.about, (ctx) => texts.aboutKeyboard(ctx.me.username, { withBack: true })),
  );

  // Say hello when added to a group.
  composer.on('my_chat_member', async (ctx) => {
    const { old_chat_member: before, new_chat_member: after } = ctx.myChatMember;
    const joined = ['left', 'kicked'].includes(before.status) && ['member', 'administrator'].includes(after.status);
    if (joined && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup')) {
      await ctx.reply(texts.addedToGroup(), { parse_mode: 'HTML' });
    }
  });

  return composer;
}

/** Friendly hints for anything in a private chat that no other handler took. */
export function createFallback() {
  const composer = new Composer();
  composer.chatType('private').on('message', (ctx) => {
    const options = { parse_mode: 'HTML' };
    if (ctx.msg.document) return ctx.reply(texts.notATorrent(), options);
    if (ctx.msg.entities?.[0]?.type === 'bot_command' && ctx.msg.entities[0].offset === 0) {
      return ctx.reply(texts.unknownCommand(), options);
    }
    return ctx.reply(texts.privateHint(), options);
  });
  composer.on('callback_query', (ctx) => ctx.answerCallbackQuery()); // stale buttons
  return composer;
}

export const BOT_COMMANDS = [
  { command: 'start', description: 'Start the bot' },
  { command: 'help', description: 'How to use the bot' },
  { command: 'convert', description: 'Convert a magnet link or a replied-to .torrent file' },
  { command: 'about', description: 'About this bot' },
];
