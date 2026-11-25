// ============================================================
//   helper/quiet.js
//   Keeps the console clean: hides Baileys/libsignal session-noise
//   (the same filter the ALEXAXMD reference console uses).
//   Require once, as early as possible.
// ============================================================
'use strict';

const NOISE = [
  'closing session: sessionentry',
  'sessionentry {',
  'failed to decrypt message with any known session',
  'session error: error: bad mac',
  'bad mac error: bad mac',
  'decrypted message with closed session',
  'incoming prekey bundle',
];

const enabled = !/^(0|false|no|off)$/i.test(String(process.env.MUTED_SIGNAL_NOISE || 'true'));
if (enabled) {
  const outWrite = process.stdout.write.bind(process.stdout);
  const errWrite = process.stderr.write.bind(process.stderr);
  let suppressStackUntil = 0;

  const text = (v) => (typeof v === 'string' ? v : Buffer.isBuffer(v) ? v.toString('utf8') : (() => { try { return String(v); } catch { return ''; } })());

  function shouldHide(v) {
    const raw = text(v);
    const low = raw.toLowerCase();
    if (NOISE.some(n => low.includes(n))) { suppressStackUntil = Date.now() + 2500; return true; }
    const stackish = low.includes('/libsignal/') || low.includes('session_cipher.js') ||
                     low.includes('queue_job.js') || /^\s*at\s/.test(raw) || low.trim() === '...';
    return Date.now() < suppressStackUntil && stackish;
  }

  const ack = (a, b) => { const cb = typeof a === 'function' ? a : b; if (typeof cb === 'function') { try { cb(); } catch {} } return true; };

  process.stdout.write = function (chunk, enc, cb) { return shouldHide(chunk) ? ack(enc, cb) : outWrite(chunk, enc, cb); };
  process.stderr.write = function (chunk, enc, cb) { return shouldHide(chunk) ? ack(enc, cb) : errWrite(chunk, enc, cb); };

  const origLog = console.log.bind(console);
  console.log = function (...args) {
    if (args.length && shouldHide(args[0])) return;
    origLog(...args);
  };
}

module.exports = { enabled };
