
  const express = require('express');
const cron = require('node-cron');
const { Client, GatewayIntentBits, Partials } = require('discord.js');

const config = require('./config');
const logger = require('./utils/logger');
const { handleSignalCommand } = require('./commands/signal');
const { handleAccuracyCommand } = require('./commands/accuracy');
const { runTrackerCycle } = require('./services/tracker');

let clientInstance = null;

async function routeCommand(text) {
  const trimmed = text.trim();
  if (/^!signal\b/i.test(trimmed)) {
    const arg = trimmed.replace(/^!signal\s*/i, '');
    return handleSignalCommand(arg);
  }
  if (/^!accuracy\b/i.test(trimmed)) {
    return handleAccuracyCommand();
  }
  return null;
}

function startDiscordBot() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
  });
  clientInstance = client;

  client.once('ready', () => {
    logger.info(`Discord bot logged in as ${client.user.tag}`);
  });

  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    const text = message.content || '';
    if (!text.trim().startsWith('!')) return;

    logger.info(`Command from ${message.author.tag}: ${text}`);
    try {
      const reply = await routeCommand(text);
      if (reply) {
        await message.reply(reply);
      }
    } catch (err) {
      logger.error('Command handling error:', err.message);
      await message.reply(`Error: ${err.message}`).catch(() => {});
    }
  });

  client.login(config.discord.token);
  return client;
}

function startHealthServer() {
  const app = express();
  app.get('/', (req, res) => res.send('Crypto Signal Bot (Discord) is running.'));
  app.get('/health', (req, res) => res.json({ ok: true, connected: !!clientInstance?.isReady() }));
  app.listen(config.server.port, () => {
    logger.info(`Health server listening on port ${config.server.port}`);
  });
}

function startTrackerCron() {
  cron.schedule('*/2 * * * *', () => {
    runTrackerCycle().catch((err) => logger.error('Tracker cycle failed:', err.message));
  });
  logger.info('Signal tracker cron scheduled (every 2 minutes).');
}

async function main() {
  startHealthServer();
  startDiscordBot();
  startTrackerCron();
}

main().catch((err) => {
  logger.error('Fatal startup error:', err);
  process.exit(1);
});
