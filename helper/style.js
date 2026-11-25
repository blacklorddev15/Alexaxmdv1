// ============================================================
//   helper/style.js
//   Outgoing text styler: A-Z, a-z and 0-9 are rewritten into
//   Mathematical Sans-Serif Bold Italic (the "𝙖𝙗𝙘" look), so
//   every bot reply matches the menu's typography.
//
//   URLs and @mentions are left untouched - rewriting them would
//   break links and mention rendering.
// ============================================================
'use strict';

const UPPER  = '𝘼𝘽𝘾𝘿𝙀𝙁𝙂𝙃𝙄𝙅𝙆𝙇𝙈𝙉𝙊𝙋𝙌𝙍𝙎𝙏𝙐𝙑𝙒𝙓𝙔𝙕';
const LOWER  = '𝙖𝙗𝙘𝙙𝙚𝙛𝙜𝙝𝙞𝙟𝙠𝙡𝙢𝙣𝙤𝙥𝙦𝙧𝙨𝙩𝙪𝙫𝙬𝙭𝙮𝙯';
const DIGITS = '𝟬𝟭𝟮𝟯𝟰𝟱𝟲𝟳𝟴𝟵';

// Split by code point so astral characters stay intact.
const UPPER_CP = Array.from(UPPER);
const LOWER_CP = Array.from(LOWER);
const DIGIT_CP = Array.from(DIGITS);

const MAP = Object.create(null);
for (let i = 0; i < 26; i++) {
  MAP[String.fromCharCode(65 + i)] = UPPER_CP[i]; // A-Z
  MAP[String.fromCharCode(97 + i)] = LOWER_CP[i]; // a-z
}
for (let i = 0; i < 10; i++) {
  MAP[String.fromCharCode(48 + i)] = DIGIT_CP[i]; // 0-9
}

// Anything that must survive verbatim: links and mentions.
const KEEP = /(https?:\/\/[^\s]+|www\.[^\s]+|wa\.me\/[^\s]+|@\d{5,})/g;

function convert(chunk) {
  let out = '';
  for (const ch of chunk) out += MAP[ch] || ch;
  return out;
}

/**
 * Stylize outgoing text. Safe to call twice: already-styled characters are not
 * ASCII, so they are left as they are.
 */
function stylize(text) {
  const str = String(text == null ? '' : text);
  if (!str) return str;
  // A bare base64/hex blob is a credential (session string, backup payload). Styling it would
  // make it impossible to copy back, so it is returned untouched.
  if (/^[A-Za-z0-9+/=\s]{100,}$/.test(str.trim())) return str;
  const parts = str.split(KEEP);
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    // split() with a capture group puts the matches at the odd indexes.
    out += i % 2 === 1 ? parts[i] : convert(parts[i]);
  }
  return out;
}

module.exports = { stylize, MAP };
