// ============================================================
//   alexa/attach.js
//   Compatibility layer: gives the standard Baileys socket the
//   extra helpers the ElitePro command pack expects.
// ============================================================
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { downloadContentFromMessage, jidDecode } from '@whiskeysockets/baileys';
import { getBuffer } from './lib/myfunc.js';
import { imageToWebp, videoToWebp, writeExifImg, writeExifVid } from './lib/exif.js';

const require = createRequire(import.meta.url);
const { convertFont } = require('../helper/utils.js');
const FileType = require('file-type');

const toBuffer = async (path) => {
  if (Buffer.isBuffer(path)) return path;
  if (typeof path !== 'string') return Buffer.alloc(0);
  if (/^data:.*?\/.*?;base64,/i.test(path)) return Buffer.from(path.split`,`[1], 'base64');
  if (/^https?:\/\//.test(path)) return getBuffer(path);
  if (fs.existsSync(path)) return fs.readFileSync(path);
  return Buffer.alloc(0);
};

export function attachEliteSock(sock) {
  if (!sock || sock.__eliteAttached) return sock;

  // Format every outgoing text/caption, including commands that call
  // sendMessage directly instead of using m.reply().
  const originalSendMessage = sock.sendMessage.bind(sock);
  sock.sendMessage = (jid, content = {}, options) => {
    if (content && typeof content === 'object') {
      const formatted = { ...content };
      if (typeof formatted.text === 'string') formatted.text = convertFont(formatted.text, 13);
      if (typeof formatted.caption === 'string') formatted.caption = convertFont(formatted.caption, 13);
      return originalSendMessage(jid, formatted, options);
    }
    return originalSendMessage(jid, content, options);
  };

  sock.decodeJid = (jid) => {
    if (!jid) return jid;
    if (/:\d+@/gi.test(jid)) {
      const decode = jidDecode(jid) || {};
      return (decode.user && decode.server && `${decode.user}@${decode.server}`) || jid;
    }
    return jid;
  };

  sock.getName = async (jid, withoutContact = false) => {
    const id = sock.decodeJid(jid) || '';
    try {
      if (id.endsWith('@g.us')) {
        const meta = await sock.groupMetadata(id);
        return meta?.subject || id;
      }
      if (id === '0@s.whatsapp.net') return 'WhatsApp';
      const num = id.split('@')[0];
      return withoutContact ? '' : (sock.contacts?.[id]?.name || sock.contacts?.[id]?.notify || num);
    } catch {
      return id;
    }
  };

  const streamToBuffer = async (message, mtype) => {
    const type = (mtype || '').replace(/Message/gi, '') || 'image';
    const stream = await downloadContentFromMessage(message, type);
    let buffer = Buffer.alloc(0);
    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
    return buffer;
  };

  sock.downloadMediaMessage = async (message) => {
    const quoted = message?.msg || message;
    const mime = (message?.msg || message || {}).mimetype || '';
    const mtype = message?.mtype ? message.mtype.replace(/Message/gi, '') : mime.split('/')[0];
    return streamToBuffer(quoted, mtype);
  };

  sock.downloadAndSaveMediaMessage = async (message, filename, attachExtension = true) => {
    const quoted = message?.msg || message;
    const mime = (message?.msg || message || {}).mimetype || '';
    const mtype = message?.mtype ? message.mtype.replace(/Message/gi, '') : mime.split('/')[0];
    const buffer = await streamToBuffer(quoted, mtype);
    let ext = 'bin';
    try { ext = (await FileType.fromBuffer(buffer))?.ext || 'bin'; } catch {}
    const file = attachExtension ? `${filename}.${ext}` : filename;
    await fs.promises.writeFile(file, buffer);
    return file;
  };

  sock.sendImageAsSticker = async (jid, path, quoted, options = {}) => {
    const buff = await toBuffer(path);
    const buffer = (options && (options.packname || options.author))
      ? await writeExifImg(buff, options)
      : await imageToWebp(buff);
    await sock.sendMessage(jid, { sticker: { url: buffer }, ...options }, { quoted });
    return buffer;
  };

  sock.sendVideoAsSticker = async (jid, path, quoted, options = {}) => {
    const buff = await toBuffer(path);
    const buffer = (options && (options.packname || options.author))
      ? await writeExifVid(buff, options)
      : await videoToWebp(buff);
    await sock.sendMessage(jid, { sticker: { url: buffer }, ...options }, { quoted });
    return buffer;
  };

  // Rarely used by the pack — present so a command fails cleanly instead of crashing.
  if (!sock.pdf) sock.pdf = async () => { throw new Error('pdf() is not available in this build'); };
  if (!sock.sendStickerPack) sock.sendStickerPack = async () => { throw new Error('sendStickerPack() is not available in this build'); };
  if (!sock.updateProfileStatus) sock.updateProfileStatus = async () => {
    // Baileys has no status setter — silently ignore instead of crashing.
    return false;
  };

  sock.__eliteAttached = true;
  return sock;
}

export default attachEliteSock;
