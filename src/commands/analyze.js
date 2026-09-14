const signalEngine = require('../services/signalEngine');
const binaryEngine = require('../services/binaryEngine');
const binaryStore = require('../services/binaryStore');
const { parseDurationToMinutes } = require('./binary');
const { formatSignalMessage, formatBinarySignalMessage } = require('../utils/formatting');
const logger = require('../utils/logger');

function normalizePair(raw) {
  if (!raw) return null;
  const p = raw.trim().toUpperCase();
  return /^[A-Z0-9]{5,15}$/.test(p) ? p : null;
}

// !analyze SYMBOL            -> crypto signal (Binance), same as !signal
// !analyze SYMBOL <duration> -> binary/forex signal (Twelve Data), same as
//                                !binary - duration accepts s/m/h suffixes,
//                                e.g. !analyze EURUSD 15, !analyze EURUSD 30s
//
// Either way, replies immediately with a status message and keeps editing
// it with an elapsed-time counter while the analysis runs, so it's clear
// the bot is working (and how long it's taking) instead of the channel
// just sitting silent. Needs the raw Discord `message` object (not just a
// string reply) so it can edit its own status message.
async function handleAnalyzeCommand(message, argText) {
  const parts = (argText || '').trim().split(/\s+/).filter(Boolean);
  const symbol = parts[0] ? parts[0].toUpperCase() : null;
  const durationArg = parts[1];
  const duration = durationArg ? parseDurationToMinutes(durationArg) : null;

  const pair = normalizePair(symbol);
  if (!pair) {
    await message.reply(
      'Usage:\n' +
      '!analyze BTCUSDT              -> crypto analysis (Binance)\n' +
      '!analyze EURUSD 15            -> binary/forex analysis (Twelve Data), duration in minutes\n' +
      '!analyze EURUSD 30s           -> duration also accepts s/m/h suffixes'
    );
    return;
  }
  // Second arg present but didn't parse as a valid duration - tell them
  // instead of silently guessing which mode they meant.
  if (durationArg && duration === null) {
    await message.reply(`Could not read "${durationArg}" as a duration. Try e.g. 15, 30s, 2h, 48h.`);
    return;
  }

  const isBinary = duration !== null;
  const startedAt = Date.now();
  const elapsedSec = () => ((Date.now() - startedAt) / 1000).toFixed(1);
  const label = isBinary ? `${pair} (${durationArg})` : pair;

  let statusMsg;
  try {
    statusMsg = await message.reply(`🔍 Analyzing **${label}**... (${elapsedSec()}s)`);
  } catch (err) {
    logger.error('analyze: could not send initial status message:', err.message);
    return;
  }

  // Tick the "still working" message every 2s so it's visibly alive.
  const timer = setInterval(() => {
    statusMsg.edit(`🔍 Analyzing **${label}**... (${elapsedSec()}s)`).catch(() => {});
  }, 2000);

  try {
    let resultText;
    if (isBinary) {
      const signal = await binaryEngine.generateBinarySignal(pair, duration);
      const id = binaryStore.newId(signal.symbol);
      await binaryStore.saveNew({ ...signal, id, status: 'OPEN', result: null });
      resultText = formatBinarySignalMessage(signal);
    } else {
      const signal = await signalEngine.generateSignal(pair);
      resultText = formatSignalMessage(signal);
    }
    clearInterval(timer);
    await statusMsg.edit(`${resultText}\n\n⏱️ Analysis took ${elapsedSec()}s.`);
  } catch (err) {
    clearInterval(timer);
    logger.error('analyze command failed:', err.message);
    await statusMsg
      .edit(`❌ Could not analyze ${label}: ${err.message} (after ${elapsedSec()}s)`)
      .catch(() => {});
  }
}

module.exports = { handleAnalyzeCommand };
