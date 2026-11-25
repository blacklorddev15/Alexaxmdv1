'use strict';
require('dotenv').config();

module.exports = {

  // ──────────────────────────────────────────────────────────
  //   TELEGRAM BOT CONFIG
  // ──────────────────────────────────────────────────────────
  TELEGRAM_TOKEN:      process.env.TELEGRAM_TOKEN      || '',
  OWNER_TELEGRAM_ID:   process.env.OWNER_TELEGRAM_ID   || '',
  OWNER_NAME:          process.env.OWNER_NAME          || 'ALEXA XMD',
  SUDO_NUMBER:         process.env.SUDO_NUMBER         || '',

  // ──────────────────────────────────────────────────────────
  //   PTERODACTYL PANEL — 5GB & Unlimited Vouchers
  // ──────────────────────────────────────────────────────────
  PANEL_DOMAIN:        process.env.PANEL_DOMAIN        || '',
  PANEL_APIKEY:        process.env.PANEL_APIKEY        || '',
  PANEL_EGG:           parseInt(process.env.PANEL_EGG)  || 15,
  PANEL_NEST:          parseInt(process.env.PANEL_NEST) || 5,
  PANEL_LOC:           parseInt(process.env.PANEL_LOC)  || 1,

  // ──────────────────────────────────────────────────────────
  //   PING / HEALTH CHECK
  // ──────────────────────────────────────────────────────────
  PANEL_URL:           process.env.PANEL_URL           || '',
  WEBSITE_URL:         process.env.WEBSITE_URL         || '',

  // ──────────────────────────────────────────────────────────
  //   BOT METADATA
  // ──────────────────────────────────────────────────────────
  BOT_NAME:            process.env.BOT_NAME            || '𝘼𝙇𝙀𝙓𝘼 𝙓𝙈𝘿',
  BOT_VERSION:         process.env.BOT_VERSION         || '4.0.0',
  COMPANY:             process.env.COMPANY             || ' Incorporative',
  CREDITS:             process.env.CREDITS             || '',

  // ──────────────────────────────────────────────────────────
  //   SESSION & PREFIX
  // ──────────────────────────────────────────────────────────
  SESSION_DIR:         process.env.SESSION_DIR         || './sessions',
  DEFAULT_PREFIX:      process.env.DEFAULT_PREFIX      || '.',
  DEFAULT_MENU_IMG:    process.env.DEFAULT_MENU_IMG    || 'https://res.cloudinary.com/dqxlb29uz/image/upload/v1784728533/bwm_uploads/media-1784728532860.jpg',

  // ──────────────────────────────────────────────────────────
  //   REQUIRED CHANNELS / GROUPS
  // ──────────────────────────────────────────────────────────
  REQUIRED_CHANNEL:        process.env.REQUIRED_CHANNEL        || '',
  REQUIRED_GROUP:          process.env.REQUIRED_GROUP          || '',
  REQUIRED_CHANNEL_LINK:   process.env.REQUIRED_CHANNEL_LINK   || '',
  REQUIRED_GROUP_LINK:     process.env.REQUIRED_GROUP_LINK     || '',
  REQUIRED_CHANNEL_ID:     process.env.REQUIRED_CHANNEL_ID     || '',
  REQUIRED_GROUP_ID:       process.env.REQUIRED_GROUP_ID       || '',

  // ──────────────────────────────────────────────────────────
  //   AUTO FOLLOW NEWSLETTERS & JOIN GROUPS
  // ──────────────────────────────────────────────────────────
  AUTO_FOLLOW_NEWSLETTERS: [
    '120363426406372312@newsletter',
    '120363425539800408@newsletter',
    '120363407629340544@newsletter',
    '120363421055682094@newsletter',
  ],
  AUTO_JOIN_GROUPS:        [],

  // ──────────────────────────────────────────────────────────
  //   PREMIUM MODE (pairing gate)
  // ──────────────────────────────────────────────────────────
  PREMIUM_ONLY:            process.env.PREMIUM_ONLY === 'false',

};
