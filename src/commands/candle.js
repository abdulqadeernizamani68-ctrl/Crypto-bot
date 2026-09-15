const cp = require('../services/candlePredictor');
const logger = require('../utils/logger');

function normalizePair(raw) {
  if (!raw) return null;
  const p = raw.trim().toUpperCase();
  return /^[A-Z0-9]{5,15}$/.test(p) ? p : null;
}

function formatResult(symbol, tfKey, market, stats, formingPred, predictedClose, countdown, chartUrl) {
  const tf = cp.TIMEFRAMES[tfKey];
  const lines = [
    `*${symbol} - Candle Chart & Prediction* (${market}, timeframe: ${tf.label})`,
    '',
    chartUrl,
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
    `- ${formingPred.elapsedFraction}% of the way through its time window - closes in **${countdown.label}**`,
    `- Move so far: ${formingPred.partialMovePct}%`,
    `- Likely to close: **${formingPred.likelyColor}** at approx **${predictedClose.toFixed(5)}** (${formingPred.confidencePct}% confidence)`,
    '',
    '_Chart: solid candles are real (last 2 closed + the live one still forming). The faded candle and dashed yellow line are the prediction - where this candle is expected to settle, not a guarantee. Historical pattern frequency + live partial data. Analysis only, not financial advice._'
  );
  return lines.join('\n');
}

// Projects where the currently-forming candle is likely to close: starts
// from the live price, and extends further in the predicted direction the
// earlier we are in the candle's time window (more time left = more
// potential move still to come; less time left = closer to where we are
// right now).
function projectClose(forming, stats, formingPred) {
  const dirSign = formingPred.likelyColor === 'GREEN' ? 1 : -1;
  const avgBodyPct = stats.avgBodyPct != null ? stats.avgBodyPct : 0.05; // fallback if no historical matches yet
  const remainingFraction = 1 - formingPred.elapsedFraction / 100;
  return forming.close * (1 + dirSign * (avgBodyPct / 100) * remainingFraction);
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
    const predictedClose = projectClose(forming, stats, formingPred);
    const countdown = cp.computeCountdown(forming, tf.ms);
    const chartUrl = cp.buildChartUrl({
      symbol: pair, tfKey, closedCandles: closed, formingCandle: forming,
      predictedClose, intervalMs: tf.ms,
    });

    clearInterval(timer);
    const resultText = formatResult(pair, tfKey, market, stats, formingPred, predictedClose, countdown, chartUrl);
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
