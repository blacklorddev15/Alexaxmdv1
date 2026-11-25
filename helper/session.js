// ============================================================
//   helper/session.js
//   Per-WhatsApp-session context (AsyncLocalStorage).
//   Gives every paired number its own settings / owners /
//   group flags, even while several sessions run in one process.
// ============================================================
'use strict';

const fs   = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();
const SESSIONS_DIR = path.resolve(__dirname, '../database/sessions');

function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch {} }

function normalizeWa(waNum) {
  return String(waNum || 'default').replace(/[^0-9A-Za-z_-]/g, '') || 'default';
}

/** Run fn() with waNum bound as the current session. */
function runWithSession(waNum, fn) {
  return als.run({ waNum: normalizeWa(waNum) }, fn);
}

/** Current session number ('default' when called outside a session). */
function currentWaNum() {
  const store = als.getStore();
  return (store && store.waNum) || 'default';
}

/** Absolute directory for one session. */
function sessionDir(waNum) {
  const dir = path.join(SESSIONS_DIR, normalizeWa(waNum || currentWaNum()));
  ensureDir(dir);
  return dir;
}

/** Absolute path of a per-session JSON/text file. */
function sessionFile(name, waNum) {
  return path.join(sessionDir(waNum || currentWaNum()), name);
}

module.exports = { runWithSession, currentWaNum, sessionDir, sessionFile, SESSIONS_DIR };
