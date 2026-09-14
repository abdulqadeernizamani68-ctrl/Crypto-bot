
  const express = require('express');
const cron = require('node-cron');
const { Client, GatewayIntentBits, Partials } = require('discord.js');

const config = require('./config');
const logger = require('./utils/logger');
const { handleSignalCommand } = require('./commands/signal');
const { handleAnalyzeCommand } = require('./commands/analyze');
const { handleHistoryCommand } = require('./commands/historyAnalyze');
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

    // !analyze needs the raw message object (to edit its own status
    // message with a live elapsed-time counter), so it's handled directly
    // here instead of going through the generic string-reply routeCommand.
    if (/^!analyze\b/i.test(text.trim())) {
      const arg = text.trim().replace(/^!analyze\s*/i, '');
      try {
        await handleAnalyzeCommand(message, arg);
      } catch (err) {
        logger.error('analyze command handling error:', err.message);
      }
      return;
    }

    // Same deal for !history - it fetches/crunches a lot of candles, so it
    // needs to edit its own live status message too.
    if (/^!history\b/i.test(text.trim())) {
      const arg = text.trim().replace(/^!history\s*/i, '');
      try {
        await handleHistoryCommand(message, arg);
      } catch (err) {
        logger.error('history command handling error:', err.message);
      }
      return;
    }

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
