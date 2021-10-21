// Converters -> #ToDo itorrents scrap with HASH, OWNER_ID Logger

const m2t = require('magnet-to-torrent');
const m2tJs = require('magnet2torrent-js');
const t2m = require('torrent2magnet');


getTorrentFile = async (ctx, magnet, InputFile, status) =>
{
    const linkToFile = new m2tJs({ timeout: 15 });
    linkToFile.getTorrent(magnet)
    .then(torrent => {
        ctx.replyWithDocument(new InputFile(torrent.toTorrentFile(),`${torrent.name}.torrent`),{
            reply_to_message_id: ctx.message.message_id
        }).then(()=>{
            ctx.api.deleteMessage(status.chat.id, status.message_id);
        });
    }).catch(e => {
        // Timeout or error occured
        ctx.api.editMessageText(status.chat.id, status.message_id, "🤯")
        console.log(e)
    });
};

getMagnetLink = async (ctx, status) =>
{
    const file = await ctx.getFile();
    const tUrl = file.getUrl();
    t2m(tUrl, (err, uri) => {
        if (err) {
            ctx.reply(`Error: ${err}`)
            return console.error(err);
        }
        ctx.api.editMessageText(status.chat.id, status.message_id, '<code>' + uri + '</code>',
            {
                parse_mode: "HTML",
                reply_to_message_id: ctx.message.message_id
            }
        );
    });   
};

module.exports = { m2t, getTorrentFile, getMagnetLink }