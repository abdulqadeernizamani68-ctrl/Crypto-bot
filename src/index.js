const express = require('express');
const cron = require('node-cron');
const { Client, GatewayIntentBits, Partials } = require('discord.js');

const config = require('./config');
const logger = require('./utils/logger');
const { handleBinaryCommand } = require('./commands/binary');
const { handleBinaryAccuracyCommand } = require('./commands/binaryAccuracy');
const { handleMarketCommand } = require('./commands/market');
const { runBinaryTrackerCycle } = require('./services/binaryTracker');
const { splitForDiscord } = require('./utils/marketFormatting');

// The ONE message a user sees while a !market analysis runs. It is edited
// in place into the final report (see handleMessage).
const WAITING_TEXT = '⏳ WAITING...';

let clientInstance = null;

// `hooks.onWorkflowStart` is only used by !market (see commands/market.js).
async function routeCommand(text, scopeId, hooks = {}) {
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
    return handleMarketCommand(scopeId, arg, hooks);
  }
  return null;
}

// Delivers `text` to the user. If a WAITING message was posted it is EDITED
// into the (first chunk of the) reply; only text that doesn't fit in one
// Discord message continues in follow-up chunks - those are part of the
// final report, not progress messages. If the edit fails (message deleted,
// missing permission) it falls back to a normal reply so the result is never
// lost.
async function deliverReply(message, waiting, text) {
  const [first, ...rest] = splitForDiscord(text);
  let delivered = false;
  if (waiting) {
    try {
      await waiting.edit(first);
      delivered = true;
    } catch (err) {
      logger.warn(`Could not edit the waiting message (${err.message}); replying instead`);
    }
  }
  if (!delivered) await message.reply(first);
  for (const chunk of rest) {
    // eslint-disable-next-line no-await-in-loop
    await message.channel.send(chunk);
  }
}

// One Discord message in, one reply out. Never throws.
async function handleMessage(message, deps = {}) {
  if (message.author.bot) return;
  const text = message.content || '';
  if (!text.trim().startsWith('!')) return;

  logger.info(`Command from ${message.author.tag}: ${text}`);

  let waiting = null;
  const hooks = {
    onWorkflowStart: async () => {
      waiting = await message.reply(WAITING_TEXT);
    },
  };

  try {
    // scopeId scopes the in-process follow-up memory (commands/market.js)
    // to this Discord channel - a follow-up like "explain in Roman Urdu" in
    // the same channel reuses that channel's last analysis.
    const reply = await (deps.routeCommand || routeCommand)(text, message.channel.id, hooks);
    if (reply) {
      await deliverReply(message, waiting, reply);
    } else if (waiting) {
      await deliverReply(message, waiting, 'Error: no result was produced for that request.');
    }
  } catch (err) {
    logger.error('Command handling error:', err.message);
    // Never leave the user staring at a WAITING message.
    await deliverReply(message, waiting, `Error: ${err.message}`).catch(() => {});
  }
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

  client.on('messageCreate', (message) => {
    handleMessage(message).catch((err) => logger.error('Unhandled message error:', err.message));
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

// Only auto-start when run directly (`npm start` -> node src/index.js);
// requiring this file (tests) must not open a Discord connection, an HTTP
// port or a cron job.
if (require.main === module) {
  main().catch((err) => {
    logger.error('Fatal startup error:', err);
    process.exit(1);
  });
}

module.exports = { routeCommand, handleMessage, WAITING_TEXT };
