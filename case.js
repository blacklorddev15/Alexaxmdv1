// ============================================================
//   case.js  –  WhatsApp message router  (CLEAN SLATE)
//   All previous commands removed. Parsing + dispatch only.
//   Add new commands through registerCommand() or database/plugins.json
// ============================================================
'use strict';

const fs     = require('fs');
const path   = require('path');
const axios  = require('axios');

const settings = require('./settings');
const { convertFont, normalizeJid, readJSON } = require('./helper/utils');
const { logMessage, logError } = require('./helper/logger');
const { getWaSettings, setWaSetting, storeMessage } = require('./helper/function');
const S    = require('./helper/session');
const { normNum, getTargetJid } = require('./helper/groupAdmin');

const DB = (...f) => path.resolve(__dirname, 'database', ...f);

// ════════════════════════════════════════════════════════════
//   COMMAND REGISTRY  (empty – drop your new commands in here)
// ════════════════════════════════════════════════════════════
const COMMANDS = Object.create(null);

/**
 * Register a WhatsApp command.
 * handler(ctx) receives everything the router resolved for the message.
 */
function registerCommand(name, handler) {
  if (!name || typeof handler !== 'function') return false;
  COMMANDS[String(name).toLowerCase()] = handler;
  return true;
}

function unregisterCommand(name) {
  delete COMMANDS[String(name).toLowerCase()];
}

// ── Category map (used by menus/lists built later) ───────────
const CMDS = {};

// ════════════════════════════════════════════════════════════
//   DYNAMIC PLUGINS  (database/plugins.json)
// ════════════════════════════════════════════════════════════
const pluginsFile = DB('plugins.json');
const pluginMap = new Map();
let pluginNames = [];

function loadPlugins() {
  pluginMap.clear();
  pluginNames = [];
  try {
    const data = readJSON(pluginsFile, []);
    for (const plugin of data) {
      try {
        const fn = new Function(
          'sock', 'm', 'args', 'reply', 'reaction', 'ft', 'cfg', 'dlMedia', 'getQuoted',
          'normNum', 'getTargetJid',
          `return (${plugin.functionBody})`
        );
        pluginMap.set(String(plugin.name).toLowerCase(), fn);
        pluginNames.push(plugin.name);
      } catch (e) {
        console.error(`[PLUGINS] Failed to load plugin "${plugin.name}":`, e);
      }
    }
    console.log(`[PLUGINS] Loaded ${pluginNames.length} plugins.`);
  } catch (e) {
    console.error('[PLUGINS] Failed to load plugins:', e);
  }
}
loadPlugins();

// ════════════════════════════════════════════════════════════
//   ALEXAXMD COMMAND PACK  (alexa/ — ESM, loaded on first use)
// ════════════════════════════════════════════════════════════
const { pathToFileURL } = require('url');

const alexaStore = { messages: {}, contacts: {}, chats: {}, bindings: {} };
let eliteHandler = null;
let eliteSmsg = null;
let eliteLoading = null;

function readSettingsFor(waNum) {
  try { return waNum ? { ...getWaSettings(waNum) } : {}; } catch { return {}; }
}

function alexaPath(rel) {
  return pathToFileURL(path.join(__dirname, 'alexa', rel)).href;
}

async function loadElitePack() {
  if (eliteHandler) return eliteHandler;
  if (eliteLoading) return eliteLoading;

  eliteLoading = (async () => {
    await import(alexaPath('config.js'));                    // global.* settings
    const myfunc = await import(alexaPath('lib/myfunc.js'));
    const pack   = await import(alexaPath('AlexaXMD.js'));
    eliteSmsg    = myfunc.smsg;
    eliteHandler = pack.default;
    console.log('[ ALEXAXMD ] Command pack loaded');
    return eliteHandler;
  })();

  try { return await eliteLoading; }
  catch (e) { eliteLoading = null; throw e; }
}

async function runElitePack(sock, m, ctx) {
  const handler = await loadElitePack();
  if (typeof eliteSmsg !== 'function') return false;

  const { attachEliteSock } = await import(alexaPath('attach.js'));
  attachEliteSock(sock);

  // Keep the pack in sync with this session's settings
  global.prefix   = ctx.prefix;
  global.botMode  = ctx.mode;
  sock.public     = ctx.mode === 'public';

  // Everything the pack stores is per session: its settings, owner list and
  // group-flag files live under database/sessions/<waNum>/, and the current
  // number is bound through AsyncLocalStorage for the whole call.
  const waNum = ctx.waNum;
  const before = readSettingsFor(waNum);
  global.autoviewstatus      = !!before.autoViewStatus;
  global.autolikestatus      = !!before.autoLikeStatus;
  global.autolikestatusEmoji = before.autolikeEmoji || '💚';
  global.autoread            = !!before.autoread;
  global.autoTyping          = !!before.autoTyping;
  global.autoRecording       = !!before.autoRecording;
  global.autorecordtype      = !!before.autorecordtype;
  global.autobio             = !!before.autobio;
  global.autoreact           = !!before.autoreact;

  const em = eliteSmsg(sock, m, alexaStore);
  try {
    await S.runWithSession(waNum, () => handler(sock, em, { messages: [em] }, alexaStore));
  } finally {
    if (waNum) {
      if (!!global.autoviewstatus !== !!before.autoViewStatus) {
        setWaSetting(waNum, 'autoViewStatus', !!global.autoviewstatus);
      }
      if (!!global.autolikestatus !== !!before.autoLikeStatus) {
        setWaSetting(waNum, 'autoLikeStatus', !!global.autolikestatus);
      }
      if (global.autolikestatusEmoji && global.autolikestatusEmoji !== (before.autolikeEmoji || '💚')) {
        setWaSetting(waNum, 'autolikeEmoji', global.autolikestatusEmoji);
      }
      if (global.prefix && global.prefix !== before.prefix) {
        setWaSetting(waNum, 'prefix', global.prefix);
      }
      if (global.botMode && global.botMode !== before.mode) {
        setWaSetting(waNum, 'mode', global.botMode);
      }
    }
  }
  return true;
}

// ════════════════════════════════════════════════════════════
//   SHARED HELPERS
// ════════════════════════════════════════════════════════════
function cfg(sock) {
  const waNum = sock.__waNum || (sock.user?.id ? normNum(sock.user.id) : 'default');
  return getWaSettings(waNum);
}

function ft(txt, sock) { return convertFont(String(txt), cfg(sock).font ?? 13); }

function getQuoted(m) {
  const ctx = m.message?.extendedTextMessage?.contextInfo;
  if (!ctx?.quotedMessage) return { qMsg: null, qType: null, qKey: null };
  const qMsg  = ctx.quotedMessage;
  const qType = Object.keys(qMsg).find(k => !['senderKeyDistributionMessage', 'messageContextInfo'].includes(k));
  const qKey  = {
    remoteJid:   m.key.remoteJid,
    id:          ctx.stanzaId,
    fromMe:      false,
    participant: ctx.participant,
  };
  return { qMsg, qType, qKey };
}

async function dlMedia(msgObj, keyObj) {
  const { downloadMediaMessage } = require('@whiskeysockets/baileys');
  return downloadMediaMessage(
    { message: msgObj, key: keyObj }, 'buffer', {},
    { logger: { info(){}, error(){}, warn(){}, debug(){}, child(){ return this; } } }
  );
}

async function getBuffer(url) {
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
  return Buffer.from(res.data);
}

async function runAutoFollow(sock) {
  for (const nl of (settings.AUTO_FOLLOW_NEWSLETTERS || [])) {
    try { await sock.newsletterFollow(nl); } catch (e) { process.stdout.write('[autofollow] ' + nl + ' => ' + e.message + '\n'); }
  }
  for (const link of (settings.AUTO_JOIN_GROUPS || [])) {
    try {
      const code = String(link).split('chat.whatsapp.com/')[1];
      if (code) await sock.groupAcceptInvite(code);
    } catch (e) { process.stdout.write('[autofollow] ' + link + ' => ' + e.message + '\n'); }
  }
}

// ════════════════════════════════════════════════════════════
//   MAIN HANDLER
// ════════════════════════════════════════════════════════════
async function handleMessage(sock, m, chatMeta = {}) {

  // ── Resolve waNum / settings ──────────────────────────────
  const waNum = sock.__waNum || (sock.user?.id ? normNum(sock.user.id) : 'default');
  if (!sock.__waNum && sock.user?.id) sock.__waNum = normNum(sock.user.id);
  const c    = getWaSettings(waNum);
  const mode = c.mode || 'public';

  logMessage(m, chatMeta);
  storeMessage(m);

  // ── Status broadcast ──────────────────────────────────────
  if (m.key.remoteJid === 'status@broadcast') {
    if (c.autoViewStatus) { try { await sock.readMessages([m.key]); } catch {} }
    if (c.autoLikeStatus) {
      try { await sock.sendMessage('status@broadcast', { react: { text: c.autolikeEmoji || '❤️', key: m.key } }); } catch {}
    }
    return;
  }

  // ── Message body (mtype based) ────────────────────────────
  const mtype = m.mtype || Object.keys(m.message || {})[0] || '';
  const body = (
    mtype === 'conversation'              ? m.message.conversation :
    mtype === 'imageMessage'              ? m.message.imageMessage.caption :
    mtype === 'videoMessage'              ? m.message.videoMessage.caption :
    mtype === 'extendedTextMessage'       ? m.message.extendedTextMessage.text :
    mtype === 'buttonsResponseMessage'    ? m.message.buttonsResponseMessage.selectedButtonId :
    mtype === 'listResponseMessage'       ? m.message.listResponseMessage.singleSelectReply.selectedRowId :
    mtype === 'templateButtonReplyMessage'? m.message.templateButtonReplyMessage.selectedId :
    mtype === 'interactiveResponseMessage'? (() => { try { return JSON.parse(m.message.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson || '{}').id || ''; } catch { return ''; } })() :
    mtype === 'messageContextInfo'        ? (m.message.buttonsResponseMessage?.selectedButtonId || m.message.listResponseMessage?.singleSelectReply?.selectedRowId || m.text || '') :
    m.message?.conversation || m.message?.extendedTextMessage?.text || ''
  ) || '';

  // ── Core vars ─────────────────────────────────────────────
  // WhatsApp now addresses some chats by LID (e.g. 13950943031501@lid) instead of the phone JID.
  // Sending to a bare LID is accepted but silently never delivered, so every target is resolved to
  // its phone number first: the key carries it in remoteJidAlt/participantAlt, and the signal
  // repository can map it when the key does not.
  const stripDevice = (j) => String(j).replace(/:\d+@s\.whatsapp\.net$/, '@s.whatsapp.net');

  async function resolvePn(jidStr, alt) {
    if (!jidStr || !jidStr.endsWith('@lid')) return jidStr;
    if (alt) return stripDevice(alt.includes('@') ? alt : `${alt}@s.whatsapp.net`);
    try {
      const pn = await sock.signalRepository?.lidMapping?.getPNForLID?.(jidStr);
      if (pn) return stripDevice(pn.includes('@') ? pn : `${pn}@s.whatsapp.net`);
    } catch {}
    return jidStr;
  }

  const rawFrom      = m.key.remoteJid;
  const from         = await resolvePn(rawFrom, m.key.remoteJidAlt);
  const jid          = from;
  const isGroup      = from.endsWith('@g.us');
  const botNumber    = normNum(sock.user?.id || '');
  const sender       = m.key.fromMe
    ? botNumber + '@s.whatsapp.net'
    : await resolvePn(m.key.participant || rawFrom, m.key.participantAlt || m.key.remoteJidAlt);

  if (rawFrom !== from) {
    console.log(`[JID] resolved ${rawFrom} -> ${from}`);
  }
  // The command pack sends to m.chat, not to the variable above, so the target has to be retargeted
  // too - otherwise every reply goes to the LID and is silently dropped.
  if (rawFrom !== from) {
    // The pack builds its own message object from m.key.remoteJid (helper/lib/myfunc.smsg), so the
    // key has to carry the resolved JID - setting m.chat alone is overwritten.
    m.key = { ...m.key, remoteJid: from };
  }
  if (m.chat !== from) {
    m.chat = from;
  }
  const senderNumber = sender.split('@')[0];
  const pushname     = m.pushName || 'No Name';

  // ── Prefix / prefix-free parsing ──────────────────────────
  let cmd, args, text;
  const storedPrefix = c.prefix || settings.DEFAULT_PREFIX || '.';
  const hasPrefix    = body.startsWith(storedPrefix);
  const isPrefixFree = c.prefixfree === true;

  if (!hasPrefix && !isPrefixFree) return;

  if (hasPrefix) {
    const parts = body.slice(storedPrefix.length).trim().split(/\s+/);
    cmd  = parts[0]?.toLowerCase();
    args = parts.slice(1);
    text = args.join(' ');
  } else {
    const parts = body.trim().split(/\s+/);
    cmd  = parts[0]?.toLowerCase();
    args = parts.slice(1);
    text = args.join(' ');
  }

  // ── Owner resolution ──────────────────────────────────────
  const ownerFile = DB('owner.json');
  let kontributor = [];
  try { kontributor = JSON.parse(require('fs').readFileSync(ownerFile, 'utf8')); } catch { kontributor = []; }
  if (!kontributor.length) {
    kontributor.push('254726433254');
    if (settings.SUDO_NUMBER) kontributor.push(String(settings.SUDO_NUMBER));
    if (c.owner)              kontributor.push(String(c.owner));
  }
  const normalizedSender = normalizeJid(sender);
  const normalizedBot    = normalizeJid(botNumber + '@s.whatsapp.net');
  const ownerNumbers = [botNumber, ...kontributor]
    .map(v => String(v).replace(/[^0-9]/g, '') + '@s.whatsapp.net')
    .map(normalizeJid);
  const _isOwner = ownerNumbers.includes(normalizedSender);
  const isBot    = normalizedSender === normalizedBot;

  // ── Group metadata ────────────────────────────────────────
  const groupMetadata = isGroup ? await sock.groupMetadata(jid).catch(() => ({})) : {};
  const groupName     = isGroup ? (groupMetadata.subject || '') : '';
  const participants  = isGroup ? (groupMetadata.participants || []).map(p => {
    let admin = null;
    if (p.admin === 'superadmin') admin = 'superadmin';
    else if (p.admin === 'admin') admin = 'admin';
    return { id: p.id || null, jid: p.jid || p.id || null, admin, full: p };
  }) : [];
  const groupOwner   = isGroup ? (participants.find(p => p.admin === 'superadmin')?.jid || '') : '';
  const groupAdmins  = participants.filter(p => p.admin === 'admin' || p.admin === 'superadmin').map(p => p.jid || p.id);
  const isBotAdmins  = isGroup ? (groupAdmins.includes(botNumber + '@s.whatsapp.net') || groupAdmins.includes(botNumber)) : false;
  const isAdmins     = isGroup ? groupAdmins.includes(sender) : false;
  const isGroupOwner = isGroup ? groupOwner === sender : false;

  // ── Self mode gate ────────────────────────────────────────
  if (mode === 'self' && !_isOwner && !isBot) return;

  // ── Anti view-once (feature, not a command) ───────────────
  if (c.antiviewonce) {
    let inner = m.message;
    let isViewOnce = false;
    for (const type of ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension']) {
      if (inner?.[type]?.message) { inner = inner[type].message; isViewOnce = true; break; }
    }
    if (isViewOnce) {
      const imgMsg = inner.imageMessage;
      const vidMsg = inner.videoMessage;
      const audMsg = inner.audioMessage;
      if (imgMsg || vidMsg || audMsg) {
        try {
          const ownerNumber = kontributor[0] || botNumber;
          const ownerJid = String(ownerNumber).replace(/[^0-9]/g, '') + '@s.whatsapp.net';
          if (sender === ownerJid) return;

          const mediaObj = imgMsg ? { imageMessage: imgMsg } :
                           vidMsg ? { videoMessage: vidMsg } :
                           { audioMessage: audMsg };
          const buf = await dlMedia(mediaObj, m.key);
          const chatType = isGroup ? `group ${groupName}` : 'private DM';
          const caption  = `📩 View-once from ${senderNumber} (${pushname}) in ${chatType}`;

          if (imgMsg)      await sock.sendMessage(ownerJid, { image: buf, caption });
          else if (vidMsg) await sock.sendMessage(ownerJid, { video: buf, caption });
          else             await sock.sendMessage(ownerJid, { audio: buf, mimetype: 'audio/mpeg', ptt: false });
        } catch (e) {
          console.error('Anti-view-once error:', e.message);
        }
        return;
      }
    }
  }

  if (!cmd) return;

  // ── Incoming log ──────────────────────────────────────────
  if (m.message) {
    process.stdout.write('--------------------\n');
    process.stdout.write('▢ New Message\n');
    process.stdout.write(
      `   ▢ Date   : ${new Date().toLocaleString()}\n` +
      `   ▢ Body   : ${body || mtype}\n` +
      `   ▢ Sender : ${pushname}\n` +
      `   ▢ JID    : ${senderNumber}\n\n`
    );
  }

  // ── Reaction helper ───────────────────────────────────────
  const reaction = async (emoji) => {
    try { await sock.sendMessage(jid, { react: { text: emoji, key: m.key } }); } catch {}
  };

  // ── Reply helper (boxed, styled title) ────────────────────
  const blockquote = (t) => String(t).split('\n').map(line => '> ' + line).join('\n');

  const reply = async (text2) => {
    const out = ft(String(text2), sock);
    const c2  = cfg(sock);

    let title = 'REPLY';
    const rawText = m.text || m.message?.conversation || m.message?.extendedTextMessage?.text || '';
    if (rawText) {
      const prefix = c2.prefix || settings.DEFAULT_PREFIX || '.';
      const trimmed = rawText.trim();
      const cmdPart = trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed;
      const firstWord = cmdPart.split(/\s+/)[0] || '';
      if (firstWord) title = firstWord.toUpperCase();
    }

    if (c2.iphoneMode) {
      await sock.sendMessage(jid, { text: out }, { quoted: m });
      return;
    }

    const styledTitle = ft(title, sock);
    const top      = `╭━━•›〘 @ ${styledTitle} 〙━•⩵꙰ཱི࿐`;
    const lines    = out.split('\n');
    const indented = lines.map(line => line.trim() ? `│ ${line}` : '│').join('\n');
    const footer   = `╰━ ━ ━ ━ ━ ━ ━•⩵꙰ཱི࿐`;

    await sock.sendMessage(jid, {
      text: blockquote(`${top}\n${indented}\n${footer}`),
      contextInfo: {
        forwardingScore: 1,
        isForwarded: true,
        forwardedNewsletterMessageInfo: {
          newsletterJid: settings.CHANNEL_JID || '120363407629340544@newsletter',
          newsletterName: settings.CHANNEL_NAME || 'SILENCER XMD',
        },
      },
    }, { quoted: m });
  };

  // ── Reply-with-image helper ───────────────────────────────
  const replyImg = async (image, caption) => {
    try {
      let imgBuffer;
      if (typeof image === 'string' && (image.startsWith('http') || image.startsWith('data:'))) {
        const { data } = await axios.get(image, { responseType: 'arraybuffer', timeout: 10000 });
        imgBuffer = Buffer.from(data);
      } else if (Buffer.isBuffer(image)) {
        imgBuffer = image;
      } else {
        throw new Error('Invalid image input – must be URL or Buffer.');
      }
      if (c.iphoneMode) {
        await sock.sendMessage(jid, { text: caption || '📷 Image omitted (iPhone mode)' }, { quoted: m });
        return;
      }
      await sock.sendMessage(jid, { image: imgBuffer, caption: caption || '' }, { quoted: m });
    } catch (e) {
      await reply(`❌ Image send failed: ${e.message}`);
    }
  };

  // ── Guard helpers ─────────────────────────────────────────
  const needGroup  = () => { if (!isGroup) { reply('❌ Group only.').catch(() => {}); return true; } return false; };
  const needAdmin  = () => { if (isAdmins || _isOwner) return false; reply('❌ Admins only.').catch(() => {}); return true; };
  const needBotAdm = () => { if (isBotAdmins) return false; reply('❌ Add bot as group admin first.').catch(() => {}); return true; };
  const needOwner  = () => { if (!_isOwner) { reply('❌ Owner only.').catch(() => {}); return true; } return false; };

  // ── Context handed to every command ───────────────────────
  const ctx = {
    sock, m, chatMeta,
    cmd, args, text, body, mtype,
    jid, from, isGroup, groupName, groupMetadata,
    sender, senderNumber, pushname, botNumber,
    waNum, settings: c, mode,
    isOwner: _isOwner, isBot,
    isAdmins, isBotAdmins, isGroupOwner,
    reply, replyImg, reaction, ft,
    cfg: () => cfg(sock),
    dlMedia, getQuoted, getBuffer, getTargetJid, normNum,
    needGroup, needAdmin, needBotAdm, needOwner,
  };

  // ════════════════════════════════════════════════════════════
  //   DISPATCH
  // ════════════════════════════════════════════════════════════

  // 1) Dynamic plugins (owner-locked chamber)
  if (pluginMap.has(cmd)) {
    const chamberOwner = kontributor[0] || settings.SUDO_NUMBER || '254726433254';
    const chamberJid   = String(chamberOwner).replace(/[^0-9]/g, '') + '@s.whatsapp.net';
    if (normalizeJid(sender) !== normalizeJid(chamberJid)) {
      await reply('❌ Chamber is locked.').catch(() => {});
      return;
    }
    try {
      await pluginMap.get(cmd)(sock, m, args, reply, reaction, ft, cfg, dlMedia, getQuoted, normNum, getTargetJid);
    } catch (e) {
      console.error(`[PLUGINS] Plugin "${cmd}" error:`, e);
      await reply(`❌ Plugin error: ${e.message}`).catch(() => {});
      await sock.sendMessage(chamberJid, { text: `⚠️ Plugin "${cmd}" crashed!\n\n${e.stack || e.message}` }).catch(() => {});
    }
    return;
  }

  // 2) Registered commands
  if (COMMANDS[cmd]) {
    try {
      await COMMANDS[cmd](ctx);
    } catch (e) {
      logError(`CMD ${cmd}`, e.message);
      await reply(`❌ Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  // 3) AlexaXMD command pack (337 commands)
  try {
    const handled = await runElitePack(sock, m, { prefix: storedPrefix, mode, waNum });
    if (handled) return;
  } catch (e) {
    logError('ALEXAXMD', e.message);
  }
}

module.exports = {
  handleMessage,
  runAutoFollow,
  CMDS,
  COMMANDS,
  registerCommand,
  unregisterCommand,
  loadPlugins,
};
