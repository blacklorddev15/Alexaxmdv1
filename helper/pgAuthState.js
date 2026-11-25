// ============================================================
//   helper/pgAuthState.js
//   WhatsApp auth state stored in Postgres instead of ./sessions
//   so a dyno restart (or any container rebuild) does not force
//   every user to pair again.
//
//   Drop-in replacement for Baileys' useMultiFileAuthState:
//     const { state, saveCreds } = await usePostgresAuthState(pool, sessionId)
// ============================================================
'use strict';

const { proto, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

const TABLE = 'wa_auth_state';

// One row per credential fragment. Baileys calls set() for every key update, so writes are small.
async function ensureSessionTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      session_id text        NOT NULL,
      key        text        NOT NULL,
      value      jsonb       NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (session_id, key)
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ${TABLE}_session_idx ON ${TABLE} (session_id)`);
}

// Baileys credentials contain Buffers; BufferJSON is the supported way to round-trip them.
function encode(value) {
  return JSON.parse(JSON.stringify(value, BufferJSON.replacer));
}

function decode(value) {
  return JSON.parse(JSON.stringify(value), BufferJSON.reviver);
}

async function deletePostgresSession(pool, sessionId) {
  const res = await pool.query(`DELETE FROM ${TABLE} WHERE session_id = $1`, [sessionId]);
  return res.rowCount || 0;
}

async function usePostgresAuthState(pool, sessionId) {
  const readRow = async (key) => {
    const { rows } = await pool.query(
      `SELECT value FROM ${TABLE} WHERE session_id = $1 AND key = $2`, [sessionId, key]);
    return rows.length ? decode(rows[0].value) : null;
  };

  const writeRow = (key, value) => pool.query(
    `INSERT INTO ${TABLE} (session_id, key, value, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (session_id, key)
     DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [sessionId, key, encode(value)]);

  const deleteRow = (key) => pool.query(
    `DELETE FROM ${TABLE} WHERE session_id = $1 AND key = $2`, [sessionId, key]);

  let creds = await readRow('creds');
  if (!creds) {
    creds = initAuthCreds();
    await writeRow('creds', creds);
  }

  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        const out = {};
        await Promise.all(ids.map(async (id) => {
          let value = await readRow(`${type}-${id}`);
          if (!value) return;
          if (type === 'app-state-sync-key') {
            value = proto.Message.AppStateSyncKeyData.fromObject(value);
          }
          out[id] = value;
        }));
        return out;
      },
      set: async (data) => {
        const jobs = [];
        for (const type of Object.keys(data)) {
          const group = data[type] || {};
          for (const id of Object.keys(group)) {
            const value = group[id];
            jobs.push(value ? writeRow(`${type}-${id}`, value) : deleteRow(`${type}-${id}`));
          }
        }
        await Promise.all(jobs);
      },
    },
  };

  return { state, saveCreds: () => writeRow('creds', creds) };
}

module.exports = { ensureSessionTable, usePostgresAuthState, deletePostgresSession, TABLE };
