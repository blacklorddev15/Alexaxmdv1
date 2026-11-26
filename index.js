// ============================================================
//   𝘼𝙇𝙀𝙓𝘼 𝙓𝙈𝘿  —  LEAN CORE
//   Pairing + Voucher Panels (5GB / Unlimited) + Premium Gate
// ============================================================
'use strict';
require('dotenv').config();
require('./helper/quiet');      // hide libsignal noise
const T = require('./helper/theme');

const fs    = require('fs');
const path  = require('path');
const chalk = require('chalk');
const pino  = require('pino');
const https = require('https');
const http  = require('http');
const axios = require('axios');
const crypto = require('crypto');
const express = require('express');
const { Telegraf, Markup } = require('telegraf');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
} = require('@whiskeysockets/baileys');

const settings = require('./settings');
const { handleMessage, runAutoFollow } = require('./case');
const {
  handleAntiDelete, checkAntilink, checkAntiMedia,
  handleAntiCall, handleGroupParticipantsUpdate,
} = require('./helper/listeners');
const {
  sessionExists, listSessions, deleteSession, sessionDir,
  getWaSettings, setWaSetting, getAllPairs, getUserPairs,
  addPair, removePair, registerUser, numOf,
} = require('./helper/function');
const { ensureSessionTable, usePostgresAuthState, deletePostgresSession, listPostgresSessions } = require('./helper/pgAuthState');
const { stylize } = require('./helper/style');

// Sessions now live in Postgres, so "which sessions exist?" is the union of the disk directory and
// the database. listSessions() alone only sees creds that were never migrated, which made the bot
// start with zero sessions after every restart and stop answering.
let pgSessionIds = new Set();
async function refreshPgSessions() {
  if (!pgPool) return;
  try {
    pgSessionIds = new Set(await listPostgresSessions(pgPool));
  } catch (err) {
    logError('PG', 'list sessions: ' + err.message);
  }
}
function allSessions() {
  return Array.from(new Set([...listSessions(), ...pgSessionIds]));
}
function sessionAvailable(sid) {
  return sessionExists(sid) || pgSessionIds.has(sid);
}
const { ensureDir, formatUptime } = require('./helper/utils');
const { logInfo, logSuccess, logWarn, logError, logSession } = require('./helper/logger');
const S = require('./helper/session');

// ─────────────────────────────────────────────────────────────
//   POSTGRES AUTH STATE
//   With DATABASE_URL set (Heroku Postgres), WhatsApp credentials are stored in the database, so a
//   dyno restart no longer wipes them and users do not have to pair again. Without it the original
//   file-based sessions are used, which keeps local runs unchanged.
// ─────────────────────────────────────────────────────────────
let pgPool = null;
if (process.env.DATABASE_URL) {
  try {
    const { Pool } = require('pg');
    const url = process.env.DATABASE_URL;
    const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
    pgPool = new Pool({
      connectionString: url,
      max: 4,
      idleTimeoutMillis: 30000,
      ssl: isLocal ? false : { rejectUnauthorized: false },
    });
    pgPool.on('error', (err) => logError('PG', err.message));
    ensureSessionTable(pgPool)
      .then(() => refreshPgSessions())
      .then(() => logSuccess('PG', 'auth state table ready - sessions persist across restarts'))
      .catch((err) => logError('PG', 'auth state table: ' + err.message));
  } catch (err) {
    logError('PG', 'pool init failed, using file sessions: ' + err.message);
    pgPool = null;
  }
}

// ─────────────────────────────────────────────────────────────
//   STYLED BUTTON (Bot API 9.4+)
// ─────────────────────────────────────────────────────────────
function styled(button, style) {
  return { ...button, style };
}

// ─────────────────────────────────────────────────────────────
//   ANIMATED COLOR CYCLE
// ─────────────────────────────────────────────────────────────
let colorIndex = 0;
const COLOR_STYLES = ['primary', 'success', 'danger'];
function getCurrentStyle() {
  return COLOR_STYLES[colorIndex % COLOR_STYLES.length];
}

// ─────────────────────────────────────────────────────────────
//   GLOBALS
// ─────────────────────────────────────────────────────────────
global.botStartTime = Date.now();
ensureDir(settings.SESSION_DIR);
ensureDir('./database');

const DB_PATH = path.join(__dirname, 'database', 'database.json');
let db = {
  users: {},
  bannedUsers: [],
  vouchers: {},
};

function loadDb() {
  try {
    if (fs.existsSync(DB_PATH)) {
      const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
      db = { ...db, ...data };
      if (!db.vouchers) db.vouchers = {};
      if (!db.bannedUsers) db.bannedUsers = [];
    }
  } catch (e) { logError('DB', 'Failed to load: ' + e.message); }
}
function saveDb() {
  try { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }
  catch (e) { logError('DB', 'Failed to save: ' + e.message); }
}
loadDb();

// ─────────────────────────────────────────────────────────────
//   USERS
// ─────────────────────────────────────────────────────────────
function ensureUser(userId) {
  if (!db.users[userId]) {
    db.users[userId] = {
      language: 'en',
      panels: [],
      registeredAt: new Date().toISOString(),
    };
    saveDb();
  } else {
    if (!db.users[userId].language) { db.users[userId].language = 'en'; saveDb(); }
    if (!db.users[userId].panels)   { db.users[userId].panels = []; saveDb(); }
  }
}

// ─────────────────────────────────────────────────────────────
//   PREMIUM
// ─────────────────────────────────────────────────────────────
const PREMIUM_FILE = './database/prem_data.json';
function loadJSON(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; }
}
function saveJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch {}
}
const _rp = loadJSON(PREMIUM_FILE, {});
let premData = {
  premOnly: !!_rp.premOnly,
  owners: Array.isArray(_rp.owners) ? _rp.owners : [],
  premUsers: Array.isArray(_rp.premUsers) ? _rp.premUsers : [],
};
function savePrem() { saveJSON(PREMIUM_FILE, premData); }

function isOwner(id) {
  return String(id) === String(settings.OWNER_TELEGRAM_ID) || premData.owners.includes(String(id));
}
function isPremium(id) {
  return isOwner(id) || premData.premUsers.includes(String(id));
}
function isBanned(id) {
  return db.bannedUsers.includes(String(id));
}
function canPair(id) {
  if (isBanned(id)) return false;
  if (!premData.premOnly) return true;
  return isPremium(id);
}

// ─────────────────────────────────────────────────────────────
//   VOUCHER PLANS (only 5GB & Unlimited)
// ─────────────────────────────────────────────────────────────
const VOUCHER_PLANS = {
  '5gb':       { ram: 512, disk: 5120, cpu: 40, name: '5GB Panel',       icon: '💾' },
  'unlimited': { ram: 0,   disk: 0,    cpu: 0,  name: 'Unlimited Panel', icon: '♾️' },
};

function genVoucherCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function createVoucher(plan, ownerId, count = 1) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    let code;
    do { code = genVoucherCode(); } while (db.vouchers[code]);
    db.vouchers[code] = {
      plan,
      createdBy: String(ownerId),
      createdAt: new Date().toISOString(),
      usedBy: null,
      usedAt: null,
      panelUsername: null,
      panelServerId: null,
      panelDeleted: false,
    };
    codes.push(code);
  }
  saveDb();
  return codes;
}

function findVoucher(code) {
  return db.vouchers[code.toUpperCase().trim()] || null;
}

// ─────────────────────────────────────────────────────────────
//   PTERODACTYL PANEL API
// ─────────────────────────────────────────────────────────────
const PANEL_DOMAIN = process.env.PANEL_DOMAIN || settings.PANEL_DOMAIN || 'https://sky.blacklord.tech';
const PANEL_APIKEY = process.env.PANEL_APIKEY || settings.PANEL_APIKEY || '';
const PANEL_EGG    = parseInt(process.env.PANEL_EGG  || settings.PANEL_EGG  || 15);
const PANEL_NEST   = parseInt(process.env.PANEL_NEST || settings.PANEL_NEST || 5);
const PANEL_LOC    = parseInt(process.env.PANEL_LOC  || settings.PANEL_LOC  || 1);

function generatePassword(username) {
  const first = username.charAt(0).toUpperCase();
  const rest  = username.slice(1).toLowerCase();
  const digits = String(Math.floor(Math.random() * 90 + 10));
  return first + rest + digits + '!';
}

async function createPterodactylPanel(username, ramMB, diskMB, cpuPercent, isAdmin = false) {
  let userId, userPassword = null;

  userPassword = generatePassword(username);
  try {
    const userRes = await axios.post(
      `${PANEL_DOMAIN}/api/application/users`,
      {
        email: `${username}@gmail.com`,
        username,
        first_name: username,
        last_name: isAdmin ? 'Admin' : 'Panel',
        root_admin: isAdmin,
        language: 'en',
        password: userPassword,
      },
      { headers: { Authorization: `Bearer ${PANEL_APIKEY}`, 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    userId = userRes.data.attributes.id;
  } catch (e) {
    throw new Error(`User creation failed: ${e.response?.data?.errors?.[0]?.detail || e.message}`);
  }

  let allocId;
  try {
    const allocRes = await axios.get(
      `${PANEL_DOMAIN}/api/application/nodes/${PANEL_LOC}/allocations`,
      { headers: { Authorization: `Bearer ${PANEL_APIKEY}` }, timeout: 15000 }
    );
    const alloc = allocRes.data.data.find(a => a.attributes.assigned === false);
    if (!alloc) throw new Error('No available port');
    allocId = alloc.attributes.id;
  } catch (e) { throw new Error(`Allocation error: ${e.message}`); }

  let eggDetails;
  try {
    const eggRes = await axios.get(
      `${PANEL_DOMAIN}/api/application/nests/${PANEL_NEST}/eggs/${PANEL_EGG}?include=variables`,
      { headers: { Authorization: `Bearer ${PANEL_APIKEY}` }, timeout: 15000 }
    );
    eggDetails = eggRes.data.attributes;
  } catch (e) { throw new Error(`Failed to fetch egg: ${e.message}`); }

  const environment = {};
  const varData = eggDetails.relationships?.variables?.data || [];
  for (const v of varData) {
    const va = v.attributes || v;
    if (va.env_variable) environment[va.env_variable] = va.default_value || '';
  }
  environment.NODE_VERSION = '18';
  environment.INST = 'npm';
  environment.CMD_RUN = 'npm start';
  if (typeof environment.AUTO_UPDATE !== 'undefined') environment.AUTO_UPDATE = '0';

  try {
    const serverData = {
      name: `${username}-panel-${Date.now().toString().slice(-4)}`,
      user: userId,
      egg: PANEL_EGG,
      docker_image: eggDetails.docker_image || 'ghcr.io/parkervcp/yolks:nodejs_18',
      startup: eggDetails.startup || 'npm start',
      environment,
      skip_scripts: false,
      limits: { memory: ramMB, swap: 0, disk: diskMB, io: 500, cpu: cpuPercent },
      feature_limits: { databases: 1, backups: 1 },
      allocation: { default: allocId },
      deployment: { locations: [PANEL_LOC] },
      start_on_completion: true,
    };
    const srvRes = await axios.post(
      `${PANEL_DOMAIN}/api/application/servers`,
      serverData,
      { headers: { Authorization: `Bearer ${PANEL_APIKEY}`, 'Content-Type': 'application/json' }, timeout: 30000 }
    );
    return {
      success: true,
      username,
      password: userPassword,
      panelDomain: PANEL_DOMAIN,
      serverId: srvRes.data.attributes.id,
      ram: ramMB,
      disk: diskMB,
      cpu: cpuPercent,
      isAdmin,
    };
  } catch (e) {
    throw new Error(`Server creation failed: ${e.response?.data?.errors?.[0]?.detail || e.message}`);
  }
}

async function deletePterodactylServer(serverId) {
  if (!serverId) throw new Error('Missing server ID');
  try {
    await axios.delete(
      `${PANEL_DOMAIN}/api/application/servers/${serverId}`,
      { headers: { Authorization: `Bearer ${PANEL_APIKEY}` }, timeout: 15000 }
    );
    return true;
  } catch (e) {
    throw new Error(`Server delete failed: ${e.response?.data?.errors?.[0]?.detail || e.message}`);
  }
}

// ─────────────────────────────────────────────────────────────
//   LANGUAGES
// ─────────────────────────────────────────────────────────────
const SUPPORTED_LANGUAGES = [
  { code: 'en', name: 'English 🇬🇧' },
  { code: 'es', name: 'Español 🇪🇸' },
  { code: 'pt', name: 'Português 🇵🇹' },
  { code: 'fr', name: 'Français 🇫🇷' },
  { code: 'ar', name: 'العربية 🇸🇦' },
];

const TRANSLATIONS = {
  en: {
        welcome: `
  •━═〘 𝗔𝗟𝗘𝗫𝗔 𝗫𝗠𝗗 〙═━•

╭═━⪩ 〘 𝗦𝗬𝗦𝗧𝗘𝗠 𝗜𝗡𝗙𝗢 〙•━•
│⫹⫺ 𝗕𝗢𝗧:〘 𝗔𝗟𝗘𝗫𝗔 𝗫𝗠𝗗 〙
│⫹⫺ 𝗩𝗘𝗥𝗦𝗜𝗢𝗡: 𝗩𝗜𝗦𝗜𝗢𝗡 𝟮.𝟬
│⫹⫺ 𝗨𝗣𝗧𝗜𝗠𝗘: ${formatUptime(Date.now() - global.botStartTime)}
│⫹⫺ 𝗢𝗪𝗡𝗘𝗥: ⃝⃪ 𝑺𝒂𝒎𝒔𝒖𝒏𝒈
╰━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━•

╭━━•›〘 𝗧𝗔𝗣 𝗧𝗢 𝗦𝗧𝗔𝗥𝗧 〙•━•
│⌬ 🔗 𝗣𝗔𝗜𝗥 𝗔𝗟𝗘𝗫𝗔 𝗫𝗠𝗗
│⌬ 👤 𝗠𝗬 𝗣𝗥𝗢𝗙𝗜𝗟𝗘
│⌬ 📊 𝗠𝗬 𝗜𝗡𝗙𝗢
│⌬ 📋 𝗟𝗜𝗦𝗧 𝗣𝗔𝗜𝗥
│⌬ 🗑️ 𝗗𝗘𝗟 𝗣𝗔𝗜𝗥
│⌬ 💎 𝗣𝗥𝗘𝗠𝗜𝗨𝗠
│⌬ 🆓 𝗙𝗥𝗘𝗘𝗠𝗢𝗗𝗘
│⌬ 🛒 𝗣𝗔𝗡𝗘𝗟
│⌬ 🗑️ 𝗗𝗘𝗟 𝗣𝗔𝗡𝗘𝗟
╰━ ━ ━ ━ ━ ━ ━ ━ ━ ━•

⌬ 〘 𝗔𝗟𝗘𝗫𝗔 𝗫𝗠𝗗 〙`,

    languagePrompt: '🌐 *Please select your language:*',
    languageSet: '✅ Language set to *{lang}*.',
  },
  es: {
    welcome: `
  •━═〘 𝘼𝙇𝙀𝙓𝘼 𝙓𝙈𝘿 〙═━•

╭═━⪩ 〘 INFORMACIÓN 〙•━•
│⫹⫺ 𝗕𝗢𝗧:〘 𝘼𝙇𝙀𝙓𝘼 𝙓𝙈𝘿 〙
│⫹⫺ 𝗩𝗘𝗥𝗦𝗜𝗢𝗡: 𝐕𝐈𝐒𝐈𝐎𝐍 𝟐.𝟎
│⫹⫺ 𝗧𝗜𝗘𝗠𝗣𝗢: ${formatUptime(Date.now() - global.botStartTime)}
│⫹⫺ 𝗣𝗥𝗢𝗣𝗜𝗘𝗧𝗔𝗥𝗜𝗢: ⃝⃪ 𝑺𝒂𝒎𝒔𝒖𝒏𝒈
╰━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━•

╭━━•›〘 𝗧𝗢𝗖𝗔 𝗣𝗔𝗥𝗔 𝗘𝗠𝗣𝗘𝗭𝗔𝗥 〙•━•
│⌬ 🔗 Vincular
│⌬ 👤 Mi Perfil
│⌬ 📊 Mi Info
│⌬ 📋 Lista Pares
│⌬ 🗑️ Eliminar Par
│⌬ 💎 Premium
│⌬ 🆓 Modo Libre
│⌬ 🛒 Panel
│⌬ 🗑️ Eliminar Panel
╰━ ━ ━ ━ ━ ━ ━ ━ ━ ━•

⌬ 〘 𝘼𝙇𝙀𝙓𝘼 𝙓𝙈𝘿 〙`,
    languagePrompt: '🌐 *Selecciona tu idioma:*',
    languageSet: '✅ Idioma establecido a *{lang}*.',
  },
};

// ─────────────────────────────────────────────────────────────
//   SOCKETS
// ─────────────────────────────────────────────────────────────
const activeSockets = new Map();
const notifiedConnected = new Set();
const webPairRequests = new Map();
global._activeSockets = activeSockets;

// ─────────────────────────────────────────────────────────────
//   LABEL NORMALIZER
//   Telegram sends the button caption back verbatim. Captions are
//   styled with Mathematical Alphanumeric glyphs and emoji, while the
//   action map uses different glyphs — so we compare normalised keys.
// ─────────────────────────────────────────────────────────────
function normLabel(text) {
  return String(text || '')
    .normalize('NFKC')                       // 𝗠𝗬 𝗜𝗡𝗙𝗢 -> MY INFO
    .replace(/[\u200B-\u200D\uFE0E\uFE0F]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')        // strip emoji / punctuation
    .trim()
    .toLowerCase();
}
function labelKey(text) { return normLabel(text).replace(/\s+/g, ''); }

// ─────────────────────────────────────────────────────────────
//   KEYBOARD (9 buttons)
// ─────────────────────────────────────────────────────────────
function createAnimatedReplyKeyboard() {
  const s = getCurrentStyle();
  return {
    reply_markup: {
      keyboard: [
        [{ text: '🔗 𝗣𝗔𝗜𝗥 𝗔𝗟𝗘𝗫𝗔 𝗫𝗠𝗗', style: s }],
        [
          { text: '👤 𝗠𝗬 𝗣𝗥𝗢𝗙𝗜𝗟𝗘', style: s },
          { text: '📊 𝗠𝗬 𝗜𝗡𝗙𝗢',    style: 'success' },
        ],
        [
          { text: '📋 𝗟𝗜𝗦𝗧 𝗣𝗔𝗜𝗥', style: s },
          { text: '🗑️ 𝗗𝗘𝗟 𝗣𝗔𝗜𝗥', style: 'danger' },
        ],
        [
          { text: '💎 𝗣𝗥𝗘𝗠𝗜𝗨𝗠',  style: 'success' },
          { text: '🆓 𝗙𝗥𝗘𝗘𝗠𝗢𝗗𝗘', style: 'primary' },
        ],
        [
          { text: '🛒 𝗣𝗔𝗡𝗘𝗟',     style: 'success' },
          { text: '🗑️ 𝗗𝗘𝗟 𝗣𝗔𝗡𝗘𝗟', style: 'danger' },
        ],
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
    },
  };
}

const menuMessages = new Map();

async function showWelcome(ctx, lang) {
  const userId = String(ctx.from.id);
  const t = TRANSLATIONS[lang] || TRANSLATIONS.en;
  const keyboard = createAnimatedReplyKeyboard();
  const text = t.welcome;

  let msg, isPhoto = false;
  try {
    msg = await ctx.replyWithPhoto(
      { url: 'https://res.cloudinary.com/dqxlb29uz/image/upload/v1784728701/bwm_uploads/media-1784728700497.jpg' },
      { caption: text, parse_mode: 'Markdown', ...keyboard }
    );
    isPhoto = true;
  } catch {
    msg = await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
  }

  const chatId = ctx.chat.id;
  if (!menuMessages.has(chatId)) menuMessages.set(chatId, []);
  menuMessages.get(chatId).push({ messageId: msg.message_id, chatId, userId, lang, isPhoto });
}

async function animateMenuMessages(botInstance) {
  for (const [chatId, messages] of menuMessages) {
    if (messages.length > 5) messages.splice(0, messages.length - 5);
    for (const msgInfo of messages) {
      try {
        const keyboard = createAnimatedReplyKeyboard();
        const text = (TRANSLATIONS[msgInfo.lang] || TRANSLATIONS.en).welcome;
        if (msgInfo.isPhoto) {
          await botInstance.telegram.editMessageCaption(chatId, msgInfo.messageId, null, text, {
            parse_mode: 'Markdown', ...keyboard,
          });
        } else {
          await botInstance.telegram.editMessageText(chatId, msgInfo.messageId, null, text, {
            parse_mode: 'Markdown', ...keyboard,
          });
        }
      } catch {
        const idx = messages.indexOf(msgInfo);
        if (idx > -1) messages.splice(idx, 1);
      }
    }
  }
}

function startAnimationLoop(botInstance) {
  setInterval(async () => {
    try {
      colorIndex = (colorIndex + 1) % 3;
      await animateMenuMessages(botInstance);
    } catch {}
  }, 1000);
}

// ─────────────────────────────────────────────────────────────
//   WHATSAPP SESSION
// ─────────────────────────────────────────────────────────────
const ELITE_PACK_COMMANDS = 338;   // commands shipped in alexa/AlexaXMD.js

// ─────────────────────────────────────────────────────────────
//   ALEXA AUTOMATION LAYER (per-session listeners)
// ─────────────────────────────────────────────────────────────
let _alexaL = null;
async function alexaListeners() {
  if (_alexaL) return _alexaL;
  try {
    const { pathToFileURL } = require('url');
    _alexaL = await import(pathToFileURL(path.join(__dirname, 'alexa', 'listeners.js')).href);
  } catch (e) {
    logError('ELITE-LISTENERS', e.message);
    _alexaL = {};
  }
  return _alexaL;
}

// Runs a listener inside this session's context (per-number settings & files)
function withSession(sock, fn) {
  const wa = sock.__waNum || '';
  return S.runWithSession(wa, fn);
}

async function startWhatsApp(sessionId, telegramChatId = null, pairPhone = null, tgUserId = null, pairingCodeCallback = null, webPairId = null) {
  const dir = sessionDir(sessionId);
  ensureDir(dir);

  // Postgres when configured, files otherwise.
  let state, saveCreds;
  if (pgPool) {
    ({ state, saveCreds } = await usePostgresAuthState(pgPool, sessionId));
    logSession(sessionId, 'auth state: postgres');
  } else {
    ({ state, saveCreds } = await useMultiFileAuthState(dir));
  }
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    keepAliveIntervalMs: 15000,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    browser: ['Ubuntu', 'Chrome', '120.0.0.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
  });

  // Every outgoing text/caption goes through the styler so replies match the menu typography.
  // Links and @mentions are preserved by the styler itself.
  const _rawSend = sock.sendMessage.bind(sock);
  sock.sendMessage = (jid, content, options) => {
    if (content && typeof content === 'object' && !Array.isArray(content)) {
      const next = { ...content };
      const plain = next.__plain === true; // opt-out, used by templates that ship their own glyphs
      delete next.__plain;
      if (!plain) {
        if (typeof next.text === 'string') next.text = stylize(next.text);
        if (typeof next.caption === 'string') next.caption = stylize(next.caption);
      }
      content = next;
    }
    return _rawSend(jid, content, options).catch((err) => {
      // Never fail silently: an undelivered reply is otherwise indistinguishable from a crash.
      logError('SEND', `${jid} [${content && Object.keys(content).join('/')}]: ${err.message}`);
      throw err;
    });
  };

  sock.__sessionId = sessionId;
  const _phoneFromSid = sessionId.split('_').pop();
  if (_phoneFromSid && /^\d{7,}$/.test(_phoneFromSid)) sock.__waNum = _phoneFromSid;

  activeSockets.set(sessionId, sock);
  sock.ev.on('creds.update', saveCreds);

  if (!state.creds.registered && pairPhone) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(pairPhone, 'ALEXAXMD');
        if (webPairId && webPairRequests.has(webPairId)) {
          const request = webPairRequests.get(webPairId);
          request.status = 'code_ready';
          request.code = code;
          request.updatedAt = Date.now();
        }
        if (typeof pairingCodeCallback === 'function') {
          await pairingCodeCallback(code);
        } else if (telegramChatId) {
          const mainBot = global._mainBotInstance;
          if (mainBot) {
            await mainBot.telegram.sendMessage(
              telegramChatId,
              `🔑 *Pairing Code for +${pairPhone}*\n\n\`${code}\`\n\nOpen WhatsApp → Linked Devices → Link a device → Link with phone number`,
              { parse_mode: 'Markdown' }
            );
          }
        }
      } catch (e) {
        if (webPairId && webPairRequests.has(webPairId)) {
          const request = webPairRequests.get(webPairId);
          request.status = 'error';
          request.error = 'Unable to create a pairing code.';
          request.updatedAt = Date.now();
        }
        if (telegramChatId) {
          const mainBot = global._mainBotInstance;
          if (mainBot) mainBot.telegram.sendMessage(telegramChatId, `❌ Pairing failed: ${e.message}`).catch(() => {});
        }
      }
    }, 2500);
  }

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      activeSockets.delete(sessionId);
      if (webPairId && webPairRequests.has(webPairId)) {
        const request = webPairRequests.get(webPairId);
        if (code === DisconnectReason.loggedOut) request.status = 'logged_out';
        else if (request.status !== 'connected') request.status = 'disconnected';
        request.updatedAt = Date.now();
      }
      logSession(sessionId, 'disconnected');
      if (code === DisconnectReason.loggedOut) {
        logWarn(sessionId, 'Logged out – deleting session');
        notifiedConnected.delete(sessionId);
        deleteSession(sessionId);
        if (pgPool) {
          deletePostgresSession(pgPool, sessionId)
            .then((n) => logSession(sessionId, 'auth state deleted from postgres (' + n + ' rows)'))
            .catch((err) => logError('PG', 'delete failed: ' + err.message));
        }
        if (tgUserId) removePair(tgUserId, sessionId);
        if (telegramChatId) {
          const mainBot = global._mainBotInstance;
          if (mainBot) {
            mainBot.telegram.sendMessage(telegramChatId, `🚪 +${sock.__waNum || pairPhone} logged out & session deleted.`).catch(() => {});
          }
        }
      } else {
        logWarn(sessionId, 'Reconnecting...');
        setTimeout(() => startWhatsApp(sessionId, telegramChatId, null, tgUserId), 3000);
      }
    }
    if (connection === 'open') {
      const waNum = numOf(sock.user?.id || '');
      sock.__waNum = waNum;
      if (webPairId && webPairRequests.has(webPairId)) {
        const request = webPairRequests.get(webPairId);
        request.status = 'connected';
        request.code = null;
        request.number = waNum;
        request.updatedAt = Date.now();
      }
      if (tgUserId) addPair(tgUserId, sessionId, waNum);
      const c = getWaSettings(waNum);
      if (!c.owner) setWaSetting(waNum, 'owner', waNum);
      logSession(sessionId, 'connected');
      logSuccess(sessionId, `wa.me/${waNum}`);
      if (telegramChatId && !notifiedConnected.has(sessionId)) {
        notifiedConnected.add(sessionId);
        const mainBot = global._mainBotInstance;
        if (mainBot) {
          mainBot.telegram.sendMessage(telegramChatId, `✅ *Connected!*\nNumber: wa.me/${waNum}`, { parse_mode: 'Markdown' }).catch(() => {});
        }
      }
      runAutoFollow(sock).catch(() => {});
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const E = await alexaListeners();

    // ── Elite pre-checks (spam / bot floods) run before anything else ──
    for (const m of messages) {
      if (!m?.message) continue;
      withSession(sock, async () => {
        try { await E.handleAntiSpam?.(sock, m); } catch {}
        try { await E.handleAntiBot?.(sock, m); }   catch {}
      }).catch(() => {});
    }

    for (const m of messages) {
      if (!m?.message) continue;
      if (m.message.ephemeralMessage) m.message = m.message.ephemeralMessage.message;
      (async () => {
        const jid       = m.key.remoteJid || '';
        const isStatus  = jid === 'status@broadcast';
        const isGroup   = jid.endsWith('@g.us');
        const isChannel = jid.endsWith('@newsletter');

        // ── Status broadcasts: view + like (per session) ──
        if (isStatus) {
          await withSession(sock, () => E.handleStatusWatcher?.(sock, m)).catch(() => {});
          return;
        }

        const chatMeta = { groupName: '' };
        if (isGroup) {
          try {
            const meta = await sock.groupMetadata(jid);
            chatMeta.groupName = meta.subject || '';
          } catch {}
        }

        await withSession(sock, async () => {
          try { await E.handleAntiLink?.(sock, m); }  catch {}
          try { await E.handleAntiStatus?.(sock, m); } catch {}
        }).catch(() => {});

        await checkAntiMedia(sock, m);
        await handleMessage(sock, m, chatMeta);

        await withSession(sock, async () => {
          if (isGroup)    { try { await E.handleAntiStatus?.(sock, m); } catch {} }
          if (isChannel)  { try { await E.handleChannelReact?.(sock, m); } catch {} }
          try { await E.handleAutoReact?.(sock, m); } catch {}
          try { await E.handleChatbot?.(sock, m); }  catch {}
        }).catch(() => {});
      })().catch(e => logError(sessionId, e.message));
    }
  });

  // per-socket chat memory cleanup (chatbot)
  alexaListeners().then(E => withSession(sock, () => E.startChatCleanup?.(sock))).catch(() => {});

  sock.ev.on('messages.delete', async (update) => {
    if (!update?.keys?.length) return;
    const E = await alexaListeners();
    withSession(sock, async () => {
      for (const key of update.keys) {
        try { await E.handleAntiDeleteEvent?.(sock, key); } catch (e) { logError('ANTIDELETE', e.message); }
      }
    }).catch(() => {});
  });

  sock.ev.on('group-participants.update', (update) => {
    handleGroupParticipantsUpdate(sock, update).catch(() => {});
  });

  sock.ev.on('call', async (call) => {
    const E = await alexaListeners();
    withSession(sock, () => E.handleCall?.(sock, call)).catch(() => {});
  });

  return sock;
}

// ─────────────────────────────────────────────────────────────
//   TELEGRAM BOT
// ─────────────────────────────────────────────────────────────
function setupBot(botInstance) {
  const localStates = new Map();

  // ── Shared panel views (used by both /commands and keyboard buttons) ──
  async function sendProfile(ctx) {
    const userId = String(ctx.from.id);
    ensureUser(userId);
    const user = ctx.from;
    const prem = isPremium(userId);
    const pairs = getUserPairs(userId);
    const pairedList = pairs.length ? pairs.map(p => `+${p.waNum}`).join(', ') : 'None';
    const panels = db.users[userId].panels || [];

    await ctx.reply(
      `👤 *Your Profile*\n\n` +
      `🆔 ID: \`${userId}\`\n` +
      `👤 Name: ${user.first_name || ''} ${user.last_name || ''}\n` +
      `💎 Premium: ${prem ? '✅ Yes' : '❌ No'}\n` +
      `📱 Paired: ${pairedList}\n` +
      `🛒 Panels: ${panels.length}`,
      { parse_mode: 'Markdown' }
    );
  }

  async function sendListPairs(ctx) {
    const pairs = getUserPairs(String(ctx.from.id));
    if (!pairs.length) return ctx.reply('No paired numbers. Use /pair <number>');
    const list = pairs.map((p, i) => {
      const status = activeSockets.has(p.sessionId) ? '🟢' : '🔴';
      return `${i + 1}. +${p.waNum} — \`${p.sessionId}\` ${status}`;
    }).join('\n');
    await ctx.reply(`📱 *Your numbers (${pairs.length}):*\n\n${list}`, { parse_mode: 'Markdown' });
  }

  // ── Keyboard refresh ──
  botInstance.command(['menu', 'help', 'keyboard'], async (ctx) => {
    ensureUser(String(ctx.from.id));
    const t = TRANSLATIONS[db.users[String(ctx.from.id)].language || 'en'] || TRANSLATIONS.en;
    await ctx.reply(t.welcome, { parse_mode: 'Markdown', ...createAnimatedReplyKeyboard() });
  });

  // ── /start ──
  botInstance.start(async (ctx) => {
    const userId = String(ctx.from.id);
    if (isBanned(userId)) return ctx.reply('⛔ You are banned from using this bot.');
    ensureUser(userId);
    const lang = db.users[userId].language || 'en';

    if (!db.users[userId].language) {
      const langButtons = [];
      for (let i = 0; i < SUPPORTED_LANGUAGES.length; i += 2) {
        const row = [styled(Markup.button.callback(SUPPORTED_LANGUAGES[i].name, `set_lang_${SUPPORTED_LANGUAGES[i].code}`), 'primary')];
        if (i + 1 < SUPPORTED_LANGUAGES.length) {
          row.push(styled(Markup.button.callback(SUPPORTED_LANGUAGES[i + 1].name, `set_lang_${SUPPORTED_LANGUAGES[i + 1].code}`), 'primary'));
        }
        langButtons.push(row);
      }
      return ctx.reply(
        (TRANSLATIONS[lang] || TRANSLATIONS.en).languagePrompt,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard(langButtons) }
      );
    }
    await showWelcome(ctx, lang);
  });

  // ── language picker ──
  botInstance.action(/set_lang_(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const code = ctx.match[1];
    const userId = String(ctx.from.id);
    if (!SUPPORTED_LANGUAGES.some(l => l.code === code)) return ctx.reply('❌ Invalid language.');
    ensureUser(userId);
    db.users[userId].language = code;
    saveDb();
    const name = SUPPORTED_LANGUAGES.find(l => l.code === code).name;
    await ctx.editMessageText(
      (TRANSLATIONS[code] || TRANSLATIONS.en).languageSet.replace('{lang}', name),
      { parse_mode: 'Markdown' }
    );
    await showWelcome(ctx, code);
  });

  // ── pairing callbacks ──
  botInstance.action('pair_new', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = String(ctx.from.id);
    if (!canPair(userId)) {
      return ctx.editMessageText('💎 *Pairing is premium-only.*\n\nContact the owner to upgrade.', { parse_mode: 'Markdown' });
    }
    localStates.set(userId, { action: 'pair' });
    await ctx.editMessageText(
      '📱 *Enter phone number to pair:*\n\nFormat: `254700000000` (without +)',
      { parse_mode: 'Markdown' }
    );
  });

  botInstance.action('pair_existing', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = String(ctx.from.id);
    if (!canPair(userId)) {
      return ctx.editMessageText('💎 *Pairing is premium-only.*\n\nContact the owner to upgrade.', { parse_mode: 'Markdown' });
    }
    localStates.set(userId, { action: 'restore_session' });
    await ctx.editMessageText(
      '📂 *Enter your Session ID:*\n\nExample: `wa_123456789_254700000000`\n\nType /cancel to abort.',
      { parse_mode: 'Markdown' }
    );
  });

  botInstance.action('pair_cancel', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText('❌ Pairing cancelled.');
  });

  // ── /pair ──
  botInstance.command('pair', async (ctx) => {
    const userId = String(ctx.from.id);
    ensureUser(userId);
    if (isBanned(userId)) return ctx.reply('⛔ You are banned.');
    if (!canPair(userId)) {
      return ctx.reply(
        `💎 *Pairing is Premium-only*\n\n🔒 Only premium users can pair right now.\n\n📞 Contact the owner to upgrade.`,
        { parse_mode: 'Markdown' }
      );
    }
    const phone = ctx.message.text.split(/\s+/)[1]?.replace(/\D/g, '');
    if (!phone || phone.length < 7) return ctx.reply('Usage: `/pair 254704955033`', { parse_mode: 'Markdown' });

    const sessionId = `wa_${userId}_${phone}`;
    if (activeSockets.has(sessionId)) return ctx.reply(`✅ +${phone} already connected!`);
    if (sessionAvailable(sessionId)) {
      await ctx.reply(`♻️ Reconnecting +${phone}...`);
      await startWhatsApp(sessionId, ctx.chat.id, null, userId);
      return;
    }
    await ctx.reply(`🔄 Pairing *+${phone}*...`, { parse_mode: 'Markdown' });
    await startWhatsApp(sessionId, ctx.chat.id, phone, userId);
  });

  // ── /delpair ──
  botInstance.command('delpair', async (ctx) => {
    const phone = ctx.message.text.split(/\s+/)[1]?.replace(/\D/g, '');
    if (!phone) return ctx.reply('Usage: /delpair 254704955033');
    const userId = String(ctx.from.id);
    const sessionId = `wa_${userId}_${phone}`;
    const sock = activeSockets.get(sessionId);
    if (sock) {
      try { await sock.logout(); } catch {}
      try { sock.ws?.close(); } catch {}
      activeSockets.delete(sessionId);
    }
    notifiedConnected.delete(sessionId);
    removePair(userId, sessionId);
    const ok = deleteSession(sessionId);
    await ctx.reply(ok ? `🗑 +${phone} deleted.` : `ℹ️ No session found for +${phone}.`);
  });

  // ── /listpaired ──
  botInstance.command('listpaired', async (ctx) => sendListPairs(ctx));

  // ── /refreshsession ──
  botInstance.command('refreshsession', async (ctx) => {
    const userId = String(ctx.from.id);
    const pairs = getUserPairs(userId);
    if (!pairs.length) return ctx.reply('ℹ️ No paired numbers.');
    await ctx.reply(`🔄 Refreshing ${pairs.length} session(s)...`);
    let refreshed = 0;
    for (const p of pairs) {
      const sock = activeSockets.get(p.sessionId);
      if (sock) {
        try { await sock.logout(); } catch {}
        try { sock.ws?.close(); } catch {}
        activeSockets.delete(p.sessionId);
      }
      try { await startWhatsApp(p.sessionId, null, null, userId); refreshed++; } catch {}
    }
    await ctx.reply(`✅ Refreshed ${refreshed}/${pairs.length} session(s).`);
  });

  // ── /profile ──
  botInstance.command('profile', async (ctx) => sendProfile(ctx));

  // ── /mypanels ──
  botInstance.command('mypanels', async (ctx) => {
    const userId = String(ctx.from.id);
    ensureUser(userId);
    const panels = db.users[userId].panels || [];
    if (!panels.length) return ctx.reply('📭 *No panels yet.*\n\nUse 🛒 PANEL to redeem a voucher.', { parse_mode: 'Markdown' });

    let msg = `📋 *Your Panels (${panels.length})*\n\n`;
    panels.forEach((p, i) => {
      msg += `${i + 1}. *${p.type}* — \`${p.username}\`\n`;
      msg += `   📊 RAM: ${p.ram === 0 ? 'Unlimited' : p.ram + 'MB'} | 💾 Disk: ${p.disk === 0 ? 'Unlimited' : p.disk + 'MB'}\n`;
      msg += `   🔗 ${p.credentials?.domain || 'N/A'}\n\n`;
    });
    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  // ── /cancel ──
  botInstance.command('cancel', async (ctx) => {
    const userId = String(ctx.from.id);
    if (localStates.has(userId)) {
      localStates.delete(userId);
      return ctx.reply('❌ Cancelled.');
    }
    return ctx.reply('Nothing to cancel.');
  });

  // ── Owner: /premonly ──
  botInstance.command('premonly', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply('❌ Owner only.');
    premData.premOnly = !premData.premOnly;
    savePrem();
    await ctx.reply(
      premData.premOnly
        ? '🔒 *Premium-only pairing ON* — only premium users can pair.'
        : '🌐 *Free pairing ON* — everyone can pair.',
      { parse_mode: 'Markdown' }
    );
  });

  // ── Owner: /addprem ──
  botInstance.command('addprem', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply('❌ Owner only.');
    const target = ctx.message.text.split(/\s+/)[1];
    if (!target) return ctx.reply('Usage: /addprem <telegram_id>');
    if (premData.premUsers.includes(target)) return ctx.reply(`ℹ️ ${target} already premium.`);
    premData.premUsers.push(target);
    savePrem();
    await ctx.reply(`✅ Added *${target}* as premium.`, { parse_mode: 'Markdown' });
  });

  // ── Owner: /delprem ──
  botInstance.command('delprem', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply('❌ Owner only.');
    const target = ctx.message.text.split(/\s+/)[1];
    if (!target) return ctx.reply('Usage: /delprem <telegram_id>');
    const idx = premData.premUsers.indexOf(target);
    if (idx === -1) return ctx.reply(`ℹ️ ${target} is not premium.`);
    premData.premUsers.splice(idx, 1);
    savePrem();
    await ctx.reply(`🗑 Removed *${target}* from premium.`, { parse_mode: 'Markdown' });
  });

  // ── Owner: /listprem ──
  botInstance.command('listprem', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply('❌ Owner only.');
    const mode = premData.premOnly ? '🔒 Premium-only ON' : '🌐 Public (Free) OFF';
    const owners = [String(settings.OWNER_TELEGRAM_ID), ...premData.owners].join('\n') || 'none';
    const prems  = premData.premUsers.join('\n') || 'none';
    await ctx.reply(
      `*Premium Status*\n${mode}\n\n*Owners:*\n${owners}\n\n*Premium Users:*\n${prems}`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── Owner: /createvoucher ──
  botInstance.command('createvoucher', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply('❌ Owner only.');
    const args = ctx.message.text.split(/\s+/);
    if (args.length < 2) {
      return ctx.reply(
        `📝 *Create Voucher*\n\nUsage: \`/createvoucher <plan> [count]\`\n\n` +
        `*Plans:*\n• \`5gb\` — 512MB RAM · 5GB disk · 40% CPU\n• \`unlimited\` — Unlimited\n\n` +
        `Examples:\n\`/createvoucher 5gb\`\n\`/createvoucher unlimited 10\``,
        { parse_mode: 'Markdown' }
      );
    }
    const plan = args[1].toLowerCase();
    const count = Math.min(parseInt(args[2]) || 1, 50);
    if (!VOUCHER_PLANS[plan]) return ctx.reply(`❌ Invalid plan. Use: ${Object.keys(VOUCHER_PLANS).join(' or ')}`);

    const codes = createVoucher(plan, ctx.from.id, count);
    const p = VOUCHER_PLANS[plan];
    await ctx.reply(
      `✅ *${count} voucher(s) created — ${p.icon} ${p.name}*\n\n\`\`\`\n${codes.join('\n')}\n\`\`\`\n\nEach voucher = 1 panel.`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── Owner: /listvouchers ──
  botInstance.command('listvouchers', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply('❌ Owner only.');
    const entries = Object.entries(db.vouchers || {});
    if (!entries.length) return ctx.reply('ℹ️ No vouchers.');

    const unused = entries.filter(([, v]) => !v.usedBy);
    const used = entries.filter(([, v]) => v.usedBy);

    let msg = `📋 *Vouchers* (${entries.length} total)\n\n🟢 *Unused: ${unused.length}*\n`;
    unused.slice(0, 40).forEach(([c, v]) => { msg += `\`${c}\` — ${VOUCHER_PLANS[v.plan]?.name || v.plan}\n`; });
    if (unused.length > 40) msg += `…+${unused.length - 40} more\n`;

    msg += `\n🔴 *Used: ${used.length}*\n`;
    used.slice(-10).forEach(([c, v]) => { msg += `\`${c}\` → ${v.panelUsername || '?'}${v.panelDeleted ? ' 🗑️' : ''}\n`; });
    if (used.length > 10) msg += `…+${used.length - 10} more\n`;

    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  // ── Owner: /delvoucher ──
  botInstance.command('delvoucher', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply('❌ Owner only.');
    const code = ctx.message.text.split(/\s+/)[1]?.toUpperCase();
    if (!code) return ctx.reply('Usage: `/delvoucher <code>`', { parse_mode: 'Markdown' });
    const v = db.vouchers?.[code];
    if (!v) return ctx.reply(`❌ Voucher \`${code}\` not found.`, { parse_mode: 'Markdown' });
    if (v.usedBy) return ctx.reply(`❌ Voucher already used.`, { parse_mode: 'Markdown' });
    delete db.vouchers[code];
    saveDb();
    await ctx.reply(`🗑️ Voucher \`${code}\` deleted.`, { parse_mode: 'Markdown' });
  });

  // ── Owner: /panelstats ──
  botInstance.command('panelstats', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply('❌ Owner only.');
    const vs = Object.values(db.vouchers || {});
    const active  = vs.filter(v => v.usedBy && !v.panelDeleted).length;
    const deleted = vs.filter(v => v.panelDeleted).length;
    const unused  = vs.filter(v => !v.usedBy).length;
    await ctx.reply(
      `📊 *Panel Stats*\n\n🎟 Vouchers: ${vs.length}\n🟢 Unused: ${unused}\n🔴 Used: ${vs.length - unused}\n🖥️ Active: ${active}\n🗑️ Deleted: ${deleted}`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── Owner: /ban /unban ──
  botInstance.command('ban', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply('❌ Owner only.');
    const id = ctx.message.text.split(/\s+/)[1];
    if (!id) return ctx.reply('Usage: /ban <user_id>');
    if (db.bannedUsers.includes(id)) return ctx.reply(`⚠️ Already banned.`);
    db.bannedUsers.push(id);
    saveDb();
    await ctx.reply(`✅ Banned ${id}.`);
  });

  botInstance.command('unban', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply('❌ Owner only.');
    const id = ctx.message.text.split(/\s+/)[1];
    if (!id) return ctx.reply('Usage: /unban <user_id>');
    if (!db.bannedUsers.includes(id)) return ctx.reply(`⚠️ Not banned.`);
    db.bannedUsers = db.bannedUsers.filter(x => x !== id);
    saveDb();
    await ctx.reply(`✅ Unbanned ${id}.`);
  });

  // ─────────────────────────────────────────────────────────────
  //   KEYBOARD ROUTER
  // ─────────────────────────────────────────────────────────────
  const KEYBOARD_ACTIONS = {

    '🔗 𝗣𝗔𝗜𝗥 𝗔𝗟𝗘𝗫𝗔 𝗫𝗠𝗗': async (ctx) => {
      const userId = String(ctx.from.id);
      if (!canPair(userId)) {
        return ctx.reply(
          '💎 *Pairing is Premium-only*\n\n🔒 Only premium users can pair right now.\n\n📞 Contact the owner to upgrade.',
          { parse_mode: 'Markdown' }
        );
      }
      await ctx.reply(
        '🔐 *Pairing Options*',
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [styled(Markup.button.callback('📱 Pair New Device', 'pair_new'), 'primary')],
            [styled(Markup.button.callback('📂 Use Existing Session ID', 'pair_existing'), 'primary')],
            [styled(Markup.button.callback('❌ Cancel', 'pair_cancel'), 'danger')],
          ]),
        }
      );
    },

    '👤 𝗠𝗬 𝗣𝗥𝗢𝗙𝗜𝗟𝗘': async (ctx) => {
      await sendProfile(ctx);
    },

    '📊 𝗠𝗬 𝗜𝗡𝗙𝗢': async (ctx) => {
      const userId = String(ctx.from.id);
      ensureUser(userId);
      const u = db.users[userId];
      const pairs = getUserPairs(userId);
      const panels = u.panels?.length || 0;
      const prem = isPremium(userId);
      await ctx.reply(
        `📊 *My Info*\n\n` +
        `🆔 ID: \`${userId}\`\n` +
        `💎 Premium: ${prem ? '✅ Yes' : '❌ No'}\n` +
        `📱 Paired: ${pairs.length} number(s)\n` +
        `🛒 Panels: ${panels}\n` +
        `🔧 Mode: ${premData.premOnly ? '🔒 Premium-only' : '🌐 Free'}`,
        { parse_mode: 'Markdown' }
      );
    },

    '📋 𝗟𝗜𝗦𝗧 𝗣𝗔𝗜𝗥': async (ctx) => {
      await sendListPairs(ctx);
    },

    '🗑️ 𝗗𝗘𝗟 𝗣𝗔𝗜𝗥': async (ctx) => {
      localStates.set(String(ctx.from.id), { action: 'delpair' });
      await ctx.reply(
        '🗑️ *Enter phone number to delete:*\n\nFormat: `254700000000`',
        { parse_mode: 'Markdown' }
      );
    },

    '💎 𝗣𝗥𝗘𝗠𝗜𝗨𝗠': async (ctx) => {
      const userId = String(ctx.from.id);
      ensureUser(userId);
      const prem = isPremium(userId);
      const isOwn = isOwner(userId);
      const locked = premData.premOnly && !prem;
      const userTier = isOwn ? '👑 Owner' : prem ? '💎 Premium' : '🆓 Free';
      const modeText = premData.premOnly ? '🔒 Premium-only' : '🌐 Free';

      const msg =
        `💎 *Premium Status*\n\n` +
        `👤 Tier: *${userTier}*\n` +
        `🔧 Bot mode: *${modeText}*\n` +
        `👥 Premium users: ${premData.premUsers.length}\n\n` +
        `*Premium unlocks:*\n` +
        `• 🔗 WhatsApp pairing\n` +
        `• 📱 Multiple numbers\n` +
        `• 🚀 Fast session restore\n\n` +
        (locked
          ? `📞 Contact the owner to upgrade.`
          : `📞 Contact the owner if you need help.`);

      const buttons = [];
      if (isOwn) {
        buttons.push([
          styled(
            Markup.button.callback(
              premData.premOnly ? '🔓 Turn OFF premium-only' : '🔒 Turn ON premium-only',
              'toggle_prem_mode'
            ),
            premData.premOnly ? 'success' : 'danger'
          ),
        ]);
      }
      await ctx.reply(msg, {
        parse_mode: 'Markdown',
        ...(buttons.length ? Markup.inlineKeyboard(buttons) : {}),
      });
    },

    '🆓 𝗙𝗥𝗘𝗘𝗠𝗢𝗗𝗘': async (ctx) => {
      const userId = String(ctx.from.id);
      const prem = isPremium(userId);
      const pairLocked = premData.premOnly && !prem;

      await ctx.reply(
        `🆓 *Free Mode*\n\n` +
        `${pairLocked ? '🔒 *Pairing is premium-only*' : '✅ *Pairing is open to everyone*'}\n\n` +
        `*Always free:*\n` +
        `• 👤 Profile\n` +
        `• 📊 My Info\n` +
        `• 📋 List Pair\n` +
        `• 🗑️ Del Pair\n` +
        `• 🛒 Panel (voucher)\n` +
        `• 🗑️ Del Panel\n\n` +
        (pairLocked ? `💎 *Only pairing* requires premium.` : `✅ Everything is open.`),
        { parse_mode: 'Markdown' }
      );
    },

    '🛒 𝗣𝗔𝗡𝗘𝗟': async (ctx) => {
      const userId = String(ctx.from.id);
      ensureUser(userId);
      localStates.set(userId, { action: 'redeem_voucher' });
      await ctx.reply(
        `🛒 *Redeem Panel Voucher*\n\n` +
        `Send your voucher code below.\n\n` +
        `*Available plans:*\n` +
        `💾 5GB Panel\n` +
        `♾️ Unlimited Panel\n\n` +
        `⚠️ One voucher = one panel.\n` +
        `🔑 Vouchers are issued by the owner only.`,
        { parse_mode: 'Markdown' }
      );
    },

    '🗑️ 𝗗𝗘𝗟 𝗣𝗔𝗡𝗘𝗟': async (ctx) => {
      const userId = String(ctx.from.id);
      ensureUser(userId);
      const panels = db.users[userId].panels || [];
      if (!panels.length) {
        return ctx.reply(
          `📭 *No panels to delete.*\n\nUse 🛒 PANEL to redeem a voucher first.`,
          { parse_mode: 'Markdown' }
        );
      }
      const buttons = panels.map((p, i) => [
        styled(
          Markup.button.callback(
            `${p.ram === 0 ? '♾️ Unlimited' : '💾 5GB'} — ${p.username}`,
            `delpanel_${i}`
          ),
          'danger'
        )
      ]);
      buttons.push([styled(Markup.button.callback('❌ Cancel', 'delpanel_cancel'), 'primary')]);
      await ctx.reply(
        `🗑️ *Select a panel to delete:*\n\n⚠️ This permanently deletes the server.`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
      );
    },
  };

  // ── Normalised keyboard index (styled captions → action) ──
  const KB_INDEX = new Map();
  for (const [label, fn] of Object.entries(KEYBOARD_ACTIONS)) {
    KB_INDEX.set(labelKey(label), fn);
  }

  // ── Message router ──
  botInstance.on('message', async (ctx, next) => {
    if (!ctx.message?.text) return next();
    const text = ctx.message.text;
    const userId = String(ctx.from.id);

    if (isBanned(userId)) return ctx.reply('⛔ You are banned from using this bot.');

    // exact match first, then font/emoji-insensitive match
    const kb = KEYBOARD_ACTIONS[text] || KB_INDEX.get(labelKey(text));
    if (kb) return kb(ctx);

    const state = localStates.get(userId);
    if (state) return handleUserState(ctx, state, text);

    // Panel never goes silent: unknown short input → re-show the keyboard
    if (!text.startsWith('/') && text.trim().length <= 32) {
      return ctx
        .reply('🤖 Unknown option — use the buttons below.', createAnimatedReplyKeyboard())
        .catch(() => {});
    }

    return next();
  });

  // ── State handler ──
  async function handleUserState(ctx, state, text) {
    const userId = String(ctx.from.id);

    switch (state.action) {
      case 'pair': {
        const phone = text.replace(/\D/g, '');
        if (!phone || phone.length < 7) return ctx.reply('❌ Invalid phone. Use: 254700000000');
        await ctx.reply(`🔄 Pairing +${phone}...`);
        const sid = `wa_${userId}_${phone}`;
        if (activeSockets.has(sid)) return ctx.reply(`✅ +${phone} already connected!`);
        if (sessionAvailable(sid)) {
          await ctx.reply(`♻️ Reconnecting +${phone}...`);
          await startWhatsApp(sid, ctx.chat.id, null, userId);
        } else {
          await startWhatsApp(sid, ctx.chat.id, phone, userId);
        }
        break;
      }

      case 'restore_session': {
        const sid = text.trim();
        if (!sid.startsWith('wa_') || !/\d/.test(sid)) {
          return ctx.reply('❌ Invalid Session ID. Example: `wa_123456789_254700000000`', { parse_mode: 'Markdown' });
        }
        if (getUserPairs(userId).find(p => p.sessionId === sid)) {
          return ctx.reply(`ℹ️ Session \`${sid}\` already paired with your account.`, { parse_mode: 'Markdown' });
        }
        if (!sessionAvailable(sid)) return ctx.reply('❌ Session not found locally.');
        if (activeSockets.has(sid)) return ctx.reply(`✅ Session already active.`, { parse_mode: 'Markdown' });
        await ctx.reply(`🔄 Restoring session \`${sid}\`...`, { parse_mode: 'Markdown' });
        const waNum = sid.split('_').pop();
        if (waNum && /^\d{7,}$/.test(waNum)) addPair(userId, sid, waNum);
        await startWhatsApp(sid, ctx.chat.id, null, userId);
        break;
      }

      case 'delpair': {
        const phone = text.replace(/\D/g, '');
        if (!phone || phone.length < 7) return ctx.reply('❌ Invalid phone number.');
        const sid = `wa_${userId}_${phone}`;
        const sock = activeSockets.get(sid);
        if (sock) {
          try { await sock.logout(); } catch {}
          try { sock.ws?.close(); } catch {}
          activeSockets.delete(sid);
        }
        notifiedConnected.delete(sid);
        removePair(userId, sid);
        deleteSession(sid);
        await ctx.reply(`🗑️ +${phone} deleted.`);
        break;
      }

      case 'redeem_voucher': {
        const code = text.trim().toUpperCase();
        const voucher = findVoucher(code);

        if (!voucher) {
          return ctx.reply('❌ *Voucher not found.*\n\nCheck the code and try again, or /cancel.', { parse_mode: 'Markdown' });
        }
        if (voucher.usedBy) {
          return ctx.reply('❌ *Voucher already used.*\n\nContact the owner for a new one.', { parse_mode: 'Markdown' });
        }

        const plan = VOUCHER_PLANS[voucher.plan];
        if (!plan) return ctx.reply('❌ Invalid voucher plan. Contact the owner.');

        await ctx.reply(`⏳ Creating *${plan.icon} ${plan.name}*...`, { parse_mode: 'Markdown' });

        try {
          const username = `v${code.toLowerCase()}`;
          const result = await createPterodactylPanel(username, plan.ram, plan.disk, plan.cpu, false);

          const v = db.vouchers[code];
          v.usedBy = userId;
          v.usedAt = new Date().toISOString();
          v.panelUsername = result.username;
          v.panelServerId = result.serverId;

          if (!db.users[userId].panels) db.users[userId].panels = [];
          db.users[userId].panels.push({
            type: plan.name,
            username: result.username,
            ram: plan.ram,
            disk: plan.disk,
            cpu: plan.cpu,
            createdAt: new Date().toISOString(),
            credentials: {
              username: result.username,
              password: result.password,
              domain: result.panelDomain,
              serverId: result.serverId,
            },
          });
          saveDb();

          await ctx.reply(
            `✅ *${plan.icon} ${plan.name} Created!*\n\n` +
            `👤 Username: \`${result.username}\`\n` +
            `🔑 Password: \`${result.password}\`\n` +
            `📊 RAM: ${plan.ram === 0 ? 'Unlimited' : plan.ram + 'MB'}\n` +
            `💾 Disk: ${plan.disk === 0 ? 'Unlimited' : plan.disk + 'MB'}\n` +
            `⚡ CPU: ${plan.cpu === 0 ? 'Unlimited' : plan.cpu + '%'}\n` +
            `🔗 Login: ${result.panelDomain}\n\n` +
            `⚠️ *Save these credentials!*`,
            { parse_mode: 'Markdown' }
          );
        } catch (err) {
          await ctx.reply(
            `❌ Creation failed: ${err.message}\n\nVoucher *not* used — try again with the same code.`,
            { parse_mode: 'Markdown' }
          );
          localStates.set(userId, { action: 'redeem_voucher' });
          return;
        }
        break;
      }

      default:
        localStates.delete(userId);
        return ctx.reply('❌ Unknown action.');
    }
    localStates.delete(userId);
  }

  // ── Panel delete callbacks ──
  botInstance.action(/delpanel_(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const idx = parseInt(ctx.match[1]);
    const userId = String(ctx.from.id);
    const panels = db.users[userId].panels || [];
    const panel = panels[idx];
    if (!panel) return ctx.editMessageText('❌ Panel not found.');

    await ctx.editMessageText(
      `⚠️ *Confirm deletion*\n\n` +
      `Panel: \`${panel.username}\`\n` +
      `Type: ${panel.type}\n` +
      `📊 RAM: ${panel.ram === 0 ? 'Unlimited' : panel.ram + 'MB'}\n` +
      `💾 Disk: ${panel.disk === 0 ? 'Unlimited' : panel.disk + 'MB'}\n\n` +
      `🔴 *Cannot be undone.*`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [styled(Markup.button.callback('🗑️ Yes, delete', `delpanel_confirm_${idx}`), 'danger')],
          [styled(Markup.button.callback('❌ Cancel', 'delpanel_cancel'), 'primary')],
        ]),
      }
    );
  });

  botInstance.action(/delpanel_confirm_(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const idx = parseInt(ctx.match[1]);
    const userId = String(ctx.from.id);
    const panels = db.users[userId].panels || [];
    const panel = panels[idx];
    if (!panel) return ctx.editMessageText('❌ Panel not found.');

    const serverId = panel.credentials?.serverId;
    if (!serverId) return ctx.editMessageText('❌ Server ID missing.');

    try {
      await ctx.editMessageText('⏳ Deleting server...');
      await deletePterodactylServer(serverId);
      for (const v of Object.values(db.vouchers)) {
        if (v.panelServerId === serverId) { v.panelDeleted = true; break; }
      }
      panels.splice(idx, 1);
      saveDb();
      await ctx.editMessageText(`✅ Panel \`${panel.username}\` deleted.`, { parse_mode: 'Markdown' });
    } catch (err) {
      await ctx.editMessageText(`❌ Delete failed: ${err.message}`);
    }
  });

  botInstance.action('delpanel_cancel', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText('❌ Cancelled.');
  });

  // ── Toggle premium-only mode ──
  botInstance.action('toggle_prem_mode', async (ctx) => {
    await ctx.answerCbQuery();
    if (!isOwner(ctx.from.id)) return ctx.reply('❌ Owner only.');
    premData.premOnly = !premData.premOnly;
    savePrem();
    await ctx.editMessageText(
      premData.premOnly
        ? '✅ Mode: 🔒 *Premium-only pairing*'
        : '✅ Mode: 🌐 *Free pairing*',
      { parse_mode: 'Markdown' }
    );
  });

  // ── Error handler ──
  botInstance.catch((err, ctx) => {
    console.error('Bot error:', err);
    ctx.reply('An error occurred.').catch(() => {});
  });
}

// ─────────────────────────────────────────────────────────────
//   SESSION WATCHER
// ─────────────────────────────────────────────────────────────
function startSessionWatcher() {
  const restore = async () => {
    try {
      await refreshPgSessions();
      const sessions = allSessions();
      for (const sid of sessions) {
        if (activeSockets.has(sid)) continue;
        logInfo('WATCHER', `Starting session: ${sid}`);
        let tgUserId = null;
        const allPairs = getAllPairs();
        for (const [uid, pairs] of Object.entries(allPairs)) {
          if (pairs.find(p => p.sessionId === sid)) { tgUserId = uid; break; }
        }
        notifiedConnected.add(sid);
        startWhatsApp(sid, null, null, tgUserId).catch(e => logError('WATCHER', e.message));
      }
    } catch {}
  };
  setInterval(restore, 30000);
  restore().catch(() => {});
  logSuccess('WATCHER', 'Session watcher started (30s)');
}

// ─────────────────────────────────────────────────────────────
//   PING LOOP
// ─────────────────────────────────────────────────────────────
function startPingLoop() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '8kb' }));
  app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

  app.get('/health', (_req, res) => res.json({
    status: 'alive',
    uptime: formatUptime(Date.now() - global.botStartTime),
    sessions: activeSockets.size,
  }));

  app.get('/api/status', (_req, res) => res.json({
    name: settings.BOT_NAME,
    version: settings.BOT_VERSION,
    uptime: formatUptime(Date.now() - global.botStartTime),
    sessions: activeSockets.size,
    pairing: true,
  }));

  app.post('/api/pair/start', async (req, res) => {
    const phone = String(req.body?.phone || '').replace(/\D/g, '');
    if (!/^\d{7,15}$/.test(phone)) {
      return res.status(400).json({ error: 'Enter a valid WhatsApp number with country code.' });
    }
    for (const request of webPairRequests.values()) {
      if (request.phone === phone && !['connected', 'error', 'disconnected', 'logged_out'].includes(request.status)) {
        return res.json({ requestId: request.id, status: request.status });
      }
    }
    const sessionId = `web_${phone}`;
    if (activeSockets.has(sessionId)) {
      return res.status(409).json({ error: 'This WhatsApp number is already connected.' });
    }
    const id = crypto.randomBytes(18).toString('hex');
    const request = { id, phone, sessionId, status: 'starting', code: null, number: null, error: null, createdAt: Date.now(), updatedAt: Date.now() };
    webPairRequests.set(id, request);
    startWhatsApp(sessionId, null, phone, null, null, id).catch((error) => {
      request.status = 'error';
      request.error = 'Unable to start WhatsApp pairing.';
      request.updatedAt = Date.now();
      logError('WEB-PAIR', error.message);
    });
    return res.status(202).json({ requestId: id, status: request.status });
  });

  // Diagnostic: proves a reply can actually reach the linked number, without involving WhatsApp on
  // the operator's side. Disabled unless SELFTEST_KEY is set.
  app.post('/api/selftest', async (req, res) => {
    const key = req.get('x-selftest-key') || req.query.key;
    if (!process.env.SELFTEST_KEY || key !== process.env.SELFTEST_KEY) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const entries = [...activeSockets.entries()];
    if (!entries.length) return res.status(409).json({ error: 'no active session' });
    const [sessionId, sock] = entries[0];
    const phone = sessionId.split('_').pop();
    const target = `${phone}@s.whatsapp.net`;
    const started = Date.now();
    const body = req.body && typeof req.body.text === 'string' ? req.body.text : null;
    try {
      const sent = await sock.sendMessage(target, body ? { text: body, __plain: true } : { text: `Selftest ${new Date().toISOString()}` });
      res.json({ ok: true, target, ms: Date.now() - started, id: sent && sent.key && sent.key.id });
    } catch (err) {
      res.status(502).json({ ok: false, target, error: err.message });
    }
  });

  app.get('/api/pair/:id', (req, res) => {
    const request = webPairRequests.get(String(req.params.id));
    if (!request) return res.status(404).json({ error: 'Pairing request not found or expired.' });
    return res.json({ status: request.status, code: request.code, number: request.number, error: request.error });
  });

  app.listen(process.env.PORT || 3001, () => {
    logSuccess('PING', `Web server :${process.env.PORT || 3001}`);
  });

  setInterval(() => {
    const cutoff = Date.now() - 15 * 60 * 1000;
    for (const [id, request] of webPairRequests) {
      if (request.updatedAt < cutoff || request.status === 'connected') webPairRequests.delete(id);
    }
  }, 60 * 1000).unref();

  setInterval(() => {
    const uptime = formatUptime(Date.now() - global.botStartTime);
    process.stdout.write(chalk.gray(`[UPTIME] ${uptime} · sessions: ${activeSockets.size}\n`));
  }, 4 * 60 * 1000);
}

// ─────────────────────────────────────────────────────────────
//   LAUNCH
// ─────────────────────────────────────────────────────────────
async function launch() {
  global._startWhatsApp = (...args) => startWhatsApp(...args);

  const mainBot = settings.TELEGRAM_TOKEN ? new Telegraf(settings.TELEGRAM_TOKEN) : null;
  global._mainBotInstance = mainBot;
  if (mainBot) setupBot(mainBot);

  T.startupReport({
    botName: settings.BOT_NAME,
    version: settings.BOT_VERSION,
    uptime: formatUptime(Date.now() - global.botStartTime),
    prefix: settings.DEFAULT_PREFIX,
    mode: premData.premOnly ? 'premium-only' : 'public',
    owner: String(settings.OWNER_TELEGRAM_ID),
    commands: ELITE_PACK_COMMANDS,
    sessions: allSessions().length,
    telegramLabel: mainBot ? 'running' : 'not configured',
    telegramStatus: mainBot ? 'active' : 'not_configured',
    panelLabel: PANEL_DOMAIN ? 'connected' : 'not set',
    panelStatus: PANEL_DOMAIN ? 'connected' : 'not_set',
    waLabel: allSessions().length ? 'restoring sessions' : 'waiting for pairing',
    waStatus: allSessions().length ? 'connecting' : 'connecting',
    toggles: { antiDelete: true, autoStatusView: false, autoReact: false, antilink: false, anticall: false, chatbot: false, antibot: false },
  });
  logInfo('PREMIUM', `Mode: ${premData.premOnly ? 'Premium-only' : 'Public'} | Owners: ${[settings.OWNER_TELEGRAM_ID, ...premData.owners].length} | Premium: ${premData.premUsers.length}`);
  logInfo('VOUCHERS', `${Object.keys(db.vouchers).length} voucher(s) in DB`);

  if (mainBot) {
    startAnimationLoop(mainBot);
    logSuccess('ANIMATION', 'Color animation started (1s cycle)');
  }

  startPingLoop();
  startSessionWatcher();

  const list = allSessions();
  logInfo('STARTUP', `Reloading ${list.length} session(s)`);
  const allPairs = getAllPairs();
  list.forEach((sid, i) => {
    let tgUserId = null;
    for (const [uid, pairs] of Object.entries(allPairs)) {
      if (pairs.find(p => p.sessionId === sid)) { tgUserId = uid; break; }
    }
    notifiedConnected.add(sid);
    setTimeout(() => startWhatsApp(sid, null, null, tgUserId).catch(e => logError(sid, e.message)), i * 1200);
  });

  if (mainBot) {
    mainBot.launch({ dropPendingUpdates: true });
    logSuccess('TELEGRAM', 'Bot running');
  } else {
    logWarn('TELEGRAM', 'TELEGRAM_TOKEN not configured; website pairing remains available');
  }

  process.once('SIGINT',  () => { mainBot?.stop('SIGINT');  process.exit(0); });
  process.once('SIGTERM', () => { mainBot?.stop('SIGTERM'); process.exit(0); });
}

launch().catch(e => { logError('FATAL', e.message); process.exit(1); });
