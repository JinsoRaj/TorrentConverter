// A simple magnet->torrent & torrent->magnet converter Telegram bot.
// (c) JinsoRaj : https://github.com/JinsoRaj/TorrentConverter
// ToDo: DB, itorrents, Logger, Groups /cmd@bot magnetlink support.

require('dotenv').config();
const { startMsg, helpMsg, aboutMsg } = require('./helpers/commands');
const { getTorrentFile, getMagnetLink } = require('./helpers/utils');

const { Bot, InputFile, GrammyError, HttpError } = require("grammy");
const { hydrateFiles } = require("@grammyjs/files");
const bot = new Bot(process.env.BOT_TOKEN);
bot.api.config.use(hydrateFiles(bot.token));

// Commands
bot.command("start", (ctx) => {
    startMsg(ctx);
});

bot.command("help", (ctx) => {
    helpMsg(ctx);
});

bot.command("about", (ctx) => {
    aboutMsg(ctx);
});

// Handle text messages
bot.on("message:text", async (ctx) => {
    const mesg = ctx.message.text;
    var words = mesg.split(' ');
    if(mesg.startsWith('magnet:?')){
        const magnet = mesg;
        getTorrentFile(ctx, magnet, InputFile);
    }
    else if ( mesg.startsWith("/") && words[1]?.startsWith('magnet:?') ) {
        const magnet = words[1];
        getTorrentFile(ctx, magnet, InputFile);
    }
});

// Handle files
bot.on('message:document').filter(ctx => ctx.message.document.mime_type === 'application/x-bittorrent', async (ctx) => {
    var status = await ctx.reply("✍️",
    {
        parse_mode: "HTML",
        reply_to_message_id: ctx.message.message_id
    });
    getMagnetLink(ctx, status);
    
})

bot.catch((err) => {
    const ctx = err.ctx;
    console.error(`Error while handling update ${ctx.update.update_id}:`);
    const e = err.error;
    if (e instanceof GrammyError) {
      console.error("Error in request:", e.description);
    } else if (e instanceof HttpError) {
      console.error("Could not contact Telegram:", e);
    } else {
      console.error("Unknown error:", e);
    }
  });

// Start bot
bot.start();
