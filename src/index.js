
  const express = require('express');
const cron = require('node-cron');
const { Client, GatewayIntentBits, Partials } = require('discord.js');

const config = require('./config');
const logger = require('./utils/logger');
const { handleSignalCommand } = require('./commands/signal');
const { handleAccuracyCommand } = require('./commands/accuracy');
const { handleBinaryCommand } = require('./commands/binary');
const { handleBinaryAccuracyCommand } = require('./commands/binaryAccuracy');
const { handleWhyCommand } = require('./commands/why');
const { handlePerformanceCommand } = require('./commands/performance');
const { handleReviewCommand } = require('./commands/review');
const { handleHealthCommand } = require('./commands/health');
const { runTrackerCycle } = require('./services/tracker');
const { runPostmortemCycle } = require('./services/postmortemTracker');
const { runBinaryTrackerCycle } = require('./services/binaryTracker');
const { runScanCycle } = require('./services/scanner');

let clientInstance = null;

async function routeCommand(text) {
  const trimmed = text.trim();
  if (/^!signal\b/i.test(trimmed)) {
    const arg = trimmed.replace(/^!signal\s*/i, '');
    return handleSignalCommand(arg);
  }
  if (/^!why\b/i.test(trimmed)) {
    const arg = trimmed.replace(/^!why\s*/i, '');
    return handleWhyCommand(arg);
  }
  if (/^!review\b/i.test(trimmed)) {
    const arg = trimmed.replace(/^!review\s*/i, '');
    return handleReviewCommand(arg);
  }
  if (/^!performance\b/i.test(trimmed)) {
    return handlePerformanceCommand();
  }
  if (/^!health\b/i.test(trimmed)) {
    return handleHealthCommand();
  }
  if (/^!accuracy\b/i.test(trimmed)) {
    return handleAccuracyCommand();
  }
  if (/^!binaryaccuracy\b/i.test(trimmed)) {
    return handleBinaryAccuracyCommand();
  }
  if (/^!binary\b/i.test(trimmed)) {
    const arg = trimmed.replace(/^!binary\s*/i, '');
    return handleBinaryCommand(arg);
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

function startTrackerCron(discordClient) {
  cron.schedule('*/2 * * * *', () => {
    runTrackerCycle().catch((err) => logger.error('Tracker cycle failed:', err.message));
  });
  logger.info('Signal tracker cron scheduled (every 2 minutes).');

  // Checkpoints here are hours/days/weeks apart, so this doesn't need to be
  // frequent - every 30 minutes is plenty and keeps Binance/API usage low.
  cron.schedule('*/30 * * * *', () => {
    runPostmortemCycle().catch((err) => logger.error('Postmortem cycle failed:', err.message));
  });
  logger.info('Extended-invalidation postmortem cron scheduled (every 30 minutes).');

  // Binary trades expire in minutes, so this needs to be tight.
  cron.schedule('*/1 * * * *', () => {
    runBinaryTrackerCycle().catch((err) => logger.error('Binary tracker cycle failed:', err.message));
  });
  logger.info('Binary signal tracker cron scheduled (every 1 minute).');

  if (config.scanner.enabled) {
    const everyN = Math.max(1, Math.round(config.scanner.intervalMinutes));
    cron.schedule(`*/${everyN} * * * *`, () => {
      runScanCycle(discordClient).catch((err) => logger.error('Scanner cycle failed:', err.message));
    });
    logger.info(`Auto-scanner cron scheduled (every ${everyN} minutes, watching ${config.scanner.pairs.length} pairs).`);
  } else {
    logger.info('Auto-scanner is disabled (set SCANNER_ENABLED=true and SCANNER_CHANNEL_ID to turn it on).');
  }
}

async function main() {
  startHealthServer();
  const client = startDiscordBot();
  startTrackerCron(client);
}

main().catch((err) => {
  logger.error('Fatal startup error:', err);
  process.exit(1);
});
