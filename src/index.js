const express = require('express');
const cron = require('node-cron');
const { Client, GatewayIntentBits, Partials } = require('discord.js');

const config = require('./config');
const logger = require('./utils/logger');
const { handleBinaryCommand } = require('./commands/binary');
const { handleBinaryAccuracyCommand } = require('./commands/binaryAccuracy');
const { handleMarketCommand } = require('./commands/market');
const { runBinaryTrackerCycle } = require('./services/binaryTracker');

let clientInstance = null;

async function routeCommand(text, scopeId) {
  const trimmed = text.trim();
  if (/^!binaryaccuracy\b/i.test(trimmed)) {
    return handleBinaryAccuracyCommand();
  }
  if (/^!binary\b/i.test(trimmed)) {
    const arg = trimmed.replace(/^!binary\s*/i, '');
    return handleBinaryCommand(arg);
  }
  // !market is the natural-language entry point (section N): everything
  // after the prefix is parsed by services/nlu.js, not matched against
  // more regexes here - "!market EURUSD analyse karo", "!market Roman
  // Urdu mein explain karo", "!market sirf differences batao" all route
  // here and get disambiguated by the parser.
  if (/^!market\b/i.test(trimmed)) {
    const arg = trimmed.replace(/^!market\s*/i, '');
    return handleMarketCommand(scopeId, arg);
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
      // scopeId scopes conversation memory (services/analysisMemory.js) to
      // this Discord channel - a follow-up like "explain in Roman Urdu"
      // in the same channel reuses that channel's last analysis.
      const reply = await routeCommand(text, message.channel.id);
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

// Plain HTTP endpoint for the hosting platform's own uptime/health checks
// (e.g. Railway) - separate from any Discord command.
function startHealthServer() {
  const app = express();
  app.get('/', (req, res) => res.send('Binary Signal Bot (Discord) is running.'));
  app.get('/health', (req, res) => res.json({ ok: true, connected: !!clientInstance?.isReady() }));
  app.listen(config.server.port, () => {
    logger.info(`Health server listening on port ${config.server.port}`);
  });
}

function startTrackerCron() {
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
