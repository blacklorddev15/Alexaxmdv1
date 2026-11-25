// ============================================================
//   helper/logger.js  – stylish colored console output
// ============================================================
'use strict';

const chalk = require('chalk');
const moment = require('moment-timezone'); // for timezone formatting
const T = require('./theme');

const icons = {
  text:      '💬',
  image:     '🖼️',
  video:     '🎥',
  audio:     '🎵',
  sticker:   '🌀',
  document:  '📄',
  location:  '📍',
  contact:   '👤',
  reaction:  '❤️',
  poll:      '📊',
  viewOnce:  '👁️',
  unknown:   '❓',
};

function getMsgType(msg) {
  if (!msg) return 'unknown';
  if (msg.conversation || msg.extendedTextMessage)    return 'text';
  if (msg.imageMessage)     return 'image';
  if (msg.videoMessage)     return 'video';
  if (msg.audioMessage)     return 'audio';
  if (msg.stickerMessage)   return 'sticker';
  if (msg.documentMessage)  return 'document';
  if (msg.locationMessage)  return 'location';
  if (msg.contactMessage)   return 'contact';
  if (msg.reactionMessage)  return 'reaction';
  if (msg.pollCreationMessage) return 'poll';
  if (msg.viewOnceMessage || msg.viewOnceMessageV2) return 'viewOnce';
  return 'unknown';
}

function getMsgText(msg) {
  if (!msg) return '';
  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.documentMessage?.caption ||
    msg.reactionMessage?.text ||
    msg.pollCreationMessage?.name ||
    msg.locationMessage ? `[${msg.locationMessage?.degreesLatitude?.toFixed(4)}, ${msg.locationMessage?.degreesLongitude?.toFixed(4)}]` :
    msg.contactMessage?.displayName ||
    ''
  );
}

// ── Styled boxed message logger ──────────────────────────────
function logMessage(m, chatMeta = {}) {
  try {
    const msg     = m.message;
    let realMsg   = msg;
    const wrappers = ['ephemeralMessage','viewOnceMessage','viewOnceMessageV2','viewOnceMessageV2Extension'];
    for (const w of wrappers) { if (realMsg?.[w]?.message) realMsg = realMsg[w].message; }

    const type     = getMsgType(realMsg);
    const icon     = icons[type] || icons.unknown;
    const text     = getMsgText(realMsg).slice(0, 150);
    const sender   = (m.key.participant || m.key.remoteJid || '').split('@')[0].split(':')[0].replace(/\D/g,'');
    const name     = m.pushName || sender;
    const jid      = m.key.remoteJid || '';
    const isGroup  = jid.endsWith('@g.us');
    const isChannel = jid.endsWith('@newsletter');
    const isDM     = !isGroup && !isChannel;

    // ── Time with timezone ──
    const now = moment().tz('Africa/Nairobi').format('dddd, HH:mm:ss z');

    // ── Speed calculation (global) ──
    if (!global._lastMsgTime) global._lastMsgTime = Date.now();
    const speed = (Date.now() - global._lastMsgTime) / 1000;
    global._lastMsgTime = Date.now();
    const speedText = speed < 0.8 ? 'FAST' : speed < 2 ? 'MODERATE' : 'SLOW';
    const speedColor = speed < 0.8 ? chalk.green.bold : speed < 2 ? chalk.yellow.bold : chalk.red.bold;

    // ── Determine title ──
    let title = 'PRIVATE MESSAGE';
    if (isGroup && chatMeta.groupName) {
      title = chatMeta.groupName;
    } else if (isChannel && chatMeta.groupName) {
      title = chatMeta.groupName;
    }
    if (title.length > 30) title = title.slice(0, 30) + '…';

    // ── Build box (ALEXAXMD theme) ──
    console.log(T.boxTitle(title));
    console.log(T.boxRow('Type',    icon + ' ' + type));
    console.log(T.boxRow('Time',    now));
    console.log(T.boxRow('Speed',   speedColor(speed.toFixed(2) + 's [ ' + speedText + ' ]')));
    console.log(T.boxRow('Sender',  sender));
    console.log(T.boxRow('Name',    name));
    console.log(T.boxRow('Chat ID', jid || 'N/A'));
    if (isGroup && chatMeta.groupName) console.log(T.boxRow('Group', chatMeta.groupName));
    if (text) console.log(T.boxRow('Message', text));
    console.log(T.boxEnd() + '\n');

  } catch (e) {
    // Fallback simple log in case of error
    console.log(chalk.gray('─'.repeat(60)));
    console.log(chalk.yellow('⚠️  Logger error:'), e.message);
    console.log(chalk.gray('─'.repeat(60)));
  }
}

// ── Other log helpers (unchanged) ──────────────────────────

function logInfo(label, msg)    { T.log('◆ ' + chalk.bold(label) + (msg ? chalk.gray(' : ' + msg) : ''), 'cyan'); }
function logSuccess(label, msg) { T.log('✓ ' + chalk.bold(label) + (msg ? chalk.gray(' : ' + msg) : ''), 'green'); }
function logWarn(label, msg)    { T.log('! ' + chalk.bold(label) + (msg ? chalk.gray(' : ' + msg) : ''), 'yellow'); }
function logError(label, msg)   { T.log('× ' + chalk.bold(label) + (msg ? chalk.gray(' : ' + msg) : ''), 'red', true); }
function logSession(sessionId, status) {
  const icon = status === 'connected' ? '🟢' : status === 'reconnecting' ? '🟡' : '🔴';
  T.log('session ' + chalk.bold(sessionId) + ' ' + icon + ' ' + chalk.gray(status), 'magenta');
}

module.exports = { logMessage, logInfo, logSuccess, logWarn, logError, logSession, getMsgType };