const express = require('express');
const cron = require('node-cron');
const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestWaWebVersion,Browsers,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');

const config = require('./config');
const logger = require('./utils/logger');
const { useRedisAuthState } = require('./services/waAuthState');
const { handleSignalCommand } = require('./commands/signal');
const { handleAccuracyCommand } = require('./commands/accuracy');
const { runTrackerCycle } = require('./services/tracker');

let sockInstance = null;

function isAllowed(jid) {
  if (!config.wa.allowedNumbers.length) return true;
  const number = jid.split('@')[0].split(':')[0];
  return config.wa.allowedNumbers.includes(number);
}

async function routeCommand(text) {
  const trimmed = text.trim();
  if (/^!signal\b/i.test(trimmed)) {
    const arg = trimmed.replace(/^!signal\s*/i, '');
    return handleSignalCommand(arg);
  }
  if (/^!accuracy\b/i.test(trimmed)) {
    return handleAccuracyCommand();
  }
  return null; // not a recognized command - stay silent
}

async function startWhatsApp() {
  const { state, saveCreds } = await useRedisAuthState();
  const { version } = await fetchLatestWaWebVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
  });
  sockInstance = sock;

  // Headless pairing-code login (works on hosts like Render with no way to
  // scan a QR code). Only triggered when there is no existing session.
  if (!state.creds.registered && config.wa.phoneNumber) {
    try {
      await new Promise((resolve) => setTimeout(resolve, 3000));
     const code = await sock.requestPairingCode(config.wa.phoneNumber);
      logger.info('=================================================');
      logger.info(`WhatsApp pairing code: ${code}`);
      logger.info('Open WhatsApp -> Linked Devices -> Link with phone number, and enter this code.');
      logger.info('=================================================');
    } catch (err) {
      logger.error('Failed to request pairing code:', err.message);
    }
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      logger.warn(`WhatsApp connection closed (code ${statusCode}). Reconnecting: ${shouldReconnect}`);
      if (shouldReconnect) {
        startWhatsApp().catch((e) => logger.error('Reconnect failed:', e.message));
      } else {
        logger.error('Logged out. Delete the wa:auth:* keys in Redis and restart to re-link.');
      }
    } else if (connection === 'open') {
      logger.info('WhatsApp connection established.');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const jid = msg.key.remoteJid;
      if (!jid || jid.endsWith('@g.us')) continue; // ignore group chats
      if (!isAllowed(jid)) continue;

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        '';
      if (!text || !text.trim().startsWith('!')) continue;

      logger.info(`Command from ${jid}: ${text}`);
      try {
        const reply = await routeCommand(text);
        if (reply) {
          await sock.sendMessage(jid, { text: reply });
        }
      } catch (err) {
        logger.error('Command handling error:', err.message);
        await sock.sendMessage(jid, { text: `Error: ${err.message}` }).catch(() => {});
      }
    }
  });

  return sock;
}

function startHealthServer() {
  const app = express();
  app.get('/', (req, res) => res.send('WhatsApp Crypto Signal Bot is running.'));
  app.get('/health', (req, res) => res.json({ ok: true, connected: !!sockInstance }));
  app.listen(config.server.port, () => {
    logger.info(`Health server listening on port ${config.server.port}`);
  });
}

function startTrackerCron() {
  // Every 2 minutes: cheap enough for Upstash's free tier while still giving
  // reasonably tight MFE/MAE and TP/SL hit resolution.
  cron.schedule('*/2 * * * *', () => {
    runTrackerCycle().catch((err) => logger.error('Tracker cycle failed:', err.message));
  });
  logger.info('Signal tracker cron scheduled (every 2 minutes).');
}

async function main() {
  startHealthServer();
  await startWhatsApp();
  startTrackerCron();
}

main().catch((err) => {
  logger.error('Fatal startup error:', err);
  process.exit(1);
});
