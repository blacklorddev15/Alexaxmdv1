// ============================================================
//   helper/theme.js  —  console theme (ALEXAXMD)
//   Look & feel matched to blacklorddev15/Alexaxmd:
//   cyan brand tag, gray keys, ◆ section headings, ✓ ! × statuses,
//   box-drawing startup report, •ON / •OFF toggles.
// ============================================================
'use strict';

const os    = require('os');
const chalk = require('chalk');

const BRAND   = '𝘼𝙇𝙀𝙓𝘼 𝙓𝙈𝘿';
let VERSION = '4.0.0';
try { VERSION = require('../settings').BOT_VERSION || require('../package.json').version || '4.0.0'; } catch {}
const WIDTH   = 62;
const EDGE    = chalk.hex('#00D9FF');

const PAINT = {
  red: chalk.red, green: chalk.green, yellow: chalk.yellow,
  cyan: chalk.cyan, magenta: chalk.magenta, blue: chalk.blue,
  white: chalk.white, gray: chalk.gray,
};
const ICON = {
  red: '❌', green: '✅', yellow: '⚠️',
  cyan: '🔌', magenta: '🗄️', blue: '💠', white: '💡', gray: '•',
};

function stamp() { return new Date().toLocaleTimeString('en-GB', { hour12: false }); }
const INNER = WIDTH - 4;
function plain(s) { return String(s ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, ''); }
function fit(s, n) {
  const t = plain(s).replace(/\r?\n/g, ' ');
  return t.length > n ? t.slice(0, Math.max(0, n - 1)) + '…' : t.padEnd(n);
}

// ── brand tag ────────────────────────────────────────────────
function tag() { return chalk.hex('#00D9FF').bold(`[ ${BRAND} ]`); }

/** Reference-style logger: [ BRAND ] message */
function log(msg, color = 'white', isError = false) {
  const paint = PAINT[color] || PAINT.white;
  const line  = `${tag()} ${paint(String(msg))}`;
  (isError ? console.error : console.log)(line);
}

/** Timestamped variant: [12:00:00] ✅ message */
function logTS(msg, color = 'white', isError = false) {
  const paint = PAINT[color] || PAINT.white;
  const line  = `${chalk.gray.bold(`[${stamp()}]`)} ${ICON[color] || '💡'} ${paint(String(msg))}`;
  (isError ? console.error : console.log)(line);
}

const level = {
  info:    (m) => log(m, 'cyan'),
  ok:      (m) => log(m, 'green'),
  warn:    (m) => log(m, 'yellow'),
  error:   (m) => log(m, 'red', true),
  cmd:     (cmd, who, tier) => console.log(
    chalk.magenta.bold('[ CMD ]'),
    chalk.cyan('✦ ' + cmd),
    chalk.yellow('← ' + (who || '-')),
    tier === 'OWNER' ? chalk.green('[OWNER]') : tier === 'SUDO' ? chalk.blue('[SUDO]') : chalk.gray('[USER]'),
  ),
};

// ── startup report ───────────────────────────────────────────
function statusIcon(state) {
  const s = String(state || '').toLowerCase();
  if (['ok', 'ready', 'connected', 'active', 'online', 'enabled', 'passed'].includes(s)) return chalk.green('✓');
  if (['warn', 'warning', 'degraded', 'fallback', 'connecting'].includes(s))              return chalk.yellow('!');
  if (['off', 'disabled', 'not_set', 'unavailable', 'error', 'failed'].includes(s))       return chalk.red('×');
  return chalk.cyan('•');
}
function statusText(state, label) {
  const s = String(state || '').toLowerCase();
  const t = label || state || 'unknown';
  if (['ok', 'ready', 'connected', 'active', 'online', 'enabled', 'passed'].includes(s)) return chalk.green(t);
  if (['warn', 'warning', 'degraded', 'fallback', 'connecting'].includes(s))              return chalk.yellow(t);
  if (['off', 'disabled', 'not_set', 'unavailable', 'error', 'failed'].includes(s))       return chalk.red(t);
  return chalk.cyan(t);
}
function row(key, value, state) {
  const k = chalk.gray(fit(key, 18));
  const v = state ? `${statusIcon(state)} ${statusText(state, value)}` : plain(value);
  return `  ${EDGE('│')}  ${k} ${chalk.gray(':')} ${v}`;
}
function heading(text) { return `  ${EDGE('│')}  ${chalk.cyan.bold('◆ ' + text)}`; }
function separator()   { return `  ${EDGE('│')}  ${chalk.gray('─'.repeat(WIDTH - 4))}`; }
function toggle(val)   { return val ? chalk.green('•ON') : chalk.red('•OFF'); }
function togglePair(a, av, b, bv) {
  return `  ${EDGE('│')}  ${chalk.gray(fit(a, 12))} ${toggle(av)} ${chalk.gray('│')} ${chalk.gray(fit(b, 12))} ${toggle(bv)}`;
}

/**
 * Print the ALEXAXMD startup report.
 * @param {object} d  data: platform,node,time,startup,prefix,mode,owner,commands,
 *                    sessions,panel,telegram,toggles,whatsapp,account,databases
 */
function startupReport(d = {}) {
  const top    = EDGE('┌' + '─'.repeat(INNER) + '┐');
  const mid    = EDGE('├' + '─'.repeat(INNER) + '┤');
  const bottom = EDGE('└' + '─'.repeat(INNER) + '┘');
  const cap    = (t) => `  ${EDGE('│')}${chalk.white.bold(' ' + fit(t, INNER - 2))}${EDGE('│')}`;
  const rowIn  = (k, v, st) => `  ${EDGE('│')} ${chalk.gray(fit(k, 16))} ${chalk.gray(':')} ${st ? statusIcon(st) + ' ' + statusText(st, v) : plain(v)}`;
  const headIn = (t) => `  ${EDGE('│')} ${chalk.cyan.bold('◆ ' + t)}`;
  const sepIn  = () => `  ${EDGE('│')} ${chalk.gray('─'.repeat(INNER - 2))}`;
  const togg   = (a, av, b, bv) => `  ${EDGE('│')} ${chalk.gray(fit(a, 11))} ${toggle(av)} ${chalk.gray('│')} ${chalk.gray(fit(b, 11))} ${toggle(bv)}`;

  const lines = [
    top,
    cap('🤖  ' + BRAND + '  STARTING…'),
    mid,
    headIn('SYSTEM'),
    rowIn('Platform',  d.platform || os.platform()),
    rowIn('Node.js',   d.node || process.version),
    rowIn('Time',      d.time || stamp()),
    rowIn('Uptime',    d.uptime || '0s'),
    sepIn(),
    headIn('CONFIGURATION'),
    rowIn('Bot',       d.botName || BRAND),
    rowIn('Version',   'v' + (d.version || VERSION)),
    rowIn('Prefix',    d.prefix ?? '.'),
    rowIn('Mode',      String(d.mode || 'public').toUpperCase(), 'active'),
    rowIn('Owner',     d.owner || 'configured'),
    rowIn('Commands',  (d.commands ?? '—') + ' loaded', 'ready'),
    rowIn('Sessions',  (d.sessions ?? 0) + ' WhatsApp number(s)'),
    sepIn(),
    headIn('SERVICES'),
    rowIn('Telegram',    d.telegramLabel || 'running', d.telegramStatus || 'connecting'),
    rowIn('Pterodactyl', d.panelLabel || 'not set',    d.panelStatus || 'not_set'),
    rowIn('Storage',     'database/ + database/sessions/', 'ready'),
    sepIn(),
    headIn('TOGGLES'),
    togg('Status View', d.toggles?.autoStatusView, 'Status React', d.toggles?.autoStatusReact),
    togg('Typing',      d.toggles?.autoTyping,     'Recording',    d.toggles?.autoRecording),
    togg('Auto-React',  d.toggles?.autoReact,      'Anti-Delete',  d.toggles?.antiDelete),
    togg('Anti-Link',   d.toggles?.antilink,       'Anti-Call',    d.toggles?.anticall),
    togg('Chatbot',     d.toggles?.chatbot,        'Anti-Bot',     d.toggles?.antibot),
    sepIn(),
    headIn('CONNECTION'),
    rowIn('WhatsApp', d.waLabel || 'waiting for sessions', d.waStatus || 'connecting'),
    rowIn('Account',  d.account || 'hidden'),
    `  ${EDGE('│')} ${chalk.gray('─'.repeat(INNER - 2))}`,
    `  ${EDGE('│')} ${chalk.gray.bold(`(•ˇ_ˇ•)  ${BRAND} SYSTEM REPORT   (•ˇ_ˇ•)`)}`,
    bottom,
  ];
  console.log(lines.join('\n'));
}

// ── framed box (used for message cards) ──────────────────────
function boxTitle(title) {
  return EDGE('╭━━•›〘 @ ') + chalk.hex('#FFA500').bold(title) + EDGE(' 〙━•⩵꙰ཱི࿐');
}
function boxRow(key, value) {
  return `  ${EDGE('│')} ${chalk.hex('#FF6B6B')('»')} ${chalk.hex('#00D9FF')(fit(key, 12))} ${chalk.gray(':')} ${chalk.white(value)}`;
}
function boxEnd() { return EDGE('╰━ ━ ━ ━ ━ ━ ━•⩵꙰ཱི࿐'); }

module.exports = {
  BRAND, VERSION, WIDTH,
  tag, log, logTS, level,
  startupReport, row, heading, separator, toggle, togglePair,
  boxTitle, boxRow, boxEnd,
  chalk,
};
