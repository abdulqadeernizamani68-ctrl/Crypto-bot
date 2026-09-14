const cp = require('../services/candlePredictor');
const logger = require('../utils/logger');

function normalizePair(raw) {
  if (!raw) return null;
  const p = raw.trim().toUpperCase();
  return /^[A-Z0-9]{5,15}$/.test(p) ? p : null;
}

function formatResult(symbol, tfKey, market, stats, formingPred, structureText) {
  const tf = cp.TIMEFRAMES[tfKey];
  const lines = [
    `*${symbol} - Candle Prediction* (${market}, timeframe: ${tf.label})`,
    '',
    `Current pattern state: \`${stats.currentState}\` (trend|RSI zone|volatility|last closed candle color)`,
    `Similar past setups found: ${stats.sampleSize}`,
    '',
  ];

  if (stats.sampleSize > 0) {
    lines.push(
      'Historically, the candle right after a setup like this was:',
      `- Green ${stats.greenPct}% of the time, Red ${stats.redPct}% of the time`,
      `- Average body size: ${stats.avgBodyPct}%`,
      ''
    );
  } else {
    lines.push('Not enough historical matches of this exact pattern yet.', '');
  }

  lines.push(
    `📌 Currently forming ${tf.label} candle:`,
    `- ${formingPred.elapsedFraction}% of the way through its time window`,
    `- Move so far: ${formingPred.partialMovePct}%`,
    `- Likely to close: **${formingPred.likelyColor}** (${formingPred.confidencePct}% confidence - blends the historical tendency above with the actual move so far; leans more on the actual move the further through the window it is)`,
    '',
    `Recent ${tf.label} candle structure (oldest to newest, last one still forming):`,
    '```',
    structureText,
    '```',
    '',
    '_Historical pattern frequency + live partial data, not a guarantee. Analysis only, not financial advice._'
  );
  return lines.join('\n');
}

// Needs the raw Discord `message` object so it can edit its own live
// status message while it fetches candles and crunches the pattern match.
async function handleCandleCommand(message, argText) {
  const parts = (argText || '').trim().split(/\s+/).filter(Boolean);
  const pair = normalizePair(parts[0]);
  const tfKey = cp.normalizeTimeframe(parts[1]);

  if (!pair || !tfKey) {
    await message.reply(
      'Usage: !candle SYMBOL TIMEFRAME\n' +
      `e.g. !candle BTCUSDT 15m, !candle EURUSD 1h\n` +
      `Supported timeframes: ${Object.keys(cp.TIMEFRAMES).join(', ')}`
    );
    return;
  }

  const startedAt = Date.now();
  const elapsedSec = () => ((Date.now() - startedAt) / 1000).toFixed(1);
  const statusText = () => `🕯️ Analyzing **${pair} (${tfKey})** candle patterns... (${elapsedSec()}s)`;

  let statusMsg;
  try {
    statusMsg = await message.reply(statusText());
  } catch (err) {
    logger.error('candle: could not send initial status message:', err.message);
    return;
  }

  const timer = setInterval(() => {
    statusMsg.edit(statusText()).catch(() => {});
  }, 2000);

  try {
    const { candles, market } = await cp.fetchCandles(pair, tfKey);
    if (!candles || candles.length < 40) {
      throw new Error(`Not enough ${tfKey} candles for ${pair} (got ${candles ? candles.length : 0}). Need at least 40.`);
    }
    const forming = candles[candles.length - 1];
    const closed = candles.slice(0, -1);

    const stats = cp.nextCandleStats(closed);
    const tf = cp.TIMEFRAMES[tfKey];
    const formingPred = cp.predictFormingCandle(forming, tf.ms, stats.greenPct);
    const structureText = cp.renderStructure(candles, 15);

    clearInterval(timer);
    const resultText = formatResult(pair, tfKey, market, stats, formingPred, structureText);
    await statusMsg.edit(`${resultText}\n\n⏱️ Took ${elapsedSec()}s.`);
  } catch (err) {
    clearInterval(timer);
    logger.error('candle command failed:', err.message);
    await statusMsg
      .edit(`❌ Could not analyze ${pair} (${tfKey}): ${err.message} (after ${elapsedSec()}s)`)
      .catch(() => {});
  }
}

module.exports = { handleCandleCommand };
