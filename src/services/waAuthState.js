// Render's filesystem is ephemeral, so the default file-based Baileys auth
// state (useMultiFileAuthState) would force a fresh QR/pairing-code login on
// every deploy/restart. This stores the same session data in Upstash Redis
// instead, so the WhatsApp login survives restarts and redeploys.
const { initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
const { redis } = require('./redisStore');

const CREDS_KEY = 'wa:auth:creds';
const keyKey = (type, id) => `wa:auth:key:${type}:${id}`;

async function useRedisAuthState() {
  async function readCreds() {
    const raw = await redis.get(CREDS_KEY);
    if (!raw) return initAuthCreds();
    const str = typeof raw === 'string' ? raw : JSON.stringify(raw);
    return JSON.parse(str, BufferJSON.reviver);
  }

  const creds = await readCreds();

  const keys = {
    get: async (type, ids) => {
      const data = {};
      await Promise.all(
        ids.map(async (id) => {
          const raw = await redis.get(keyKey(type, id));
          if (raw) {
            const str = typeof raw === 'string' ? raw : JSON.stringify(raw);
            data[id] = JSON.parse(str, BufferJSON.reviver);
          }
        })
      );
      return data;
    },
    set: async (data) => {
      const ops = [];
      for (const type of Object.keys(data)) {
        for (const id of Object.keys(data[type])) {
          const value = data[type][id];
          if (value) {
            ops.push(redis.set(keyKey(type, id), JSON.stringify(value, BufferJSON.replacer)));
          } else {
            ops.push(redis.del(keyKey(type, id)));
          }
        }
      }
      await Promise.all(ops);
    },
  };

  const saveCreds = async () => {
    await redis.set(CREDS_KEY, JSON.stringify(creds, BufferJSON.replacer));
  };

  return { state: { creds, keys }, saveCreds };
}

module.exports = { useRedisAuthState };
