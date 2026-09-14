const hist = require('../services/historicalAnalysis');
const logger = require('../utils/logger');

// How far ahead to check outcomes, in candles (interval is 1h, so these
// are also hours). Covers short (1-2h) up to multi-day (4 days) horizons.
const CHECKPOINTS_HOURS = [1, 2, 4, 8, 12, 24, 48, 96];
const MAX_CANDLES = 5000; // ~208 days of 1h candles when available

function formatHours(h) {
  if (h < 24) return `${h}h`;
  const d = h / 24;
  return `${Number.isInteger(d) ? d : d.toFixed(1)}d`;
}

// Tries Binance first (crypto pairs, deep free history via pagination).
// If the symbol isn't a Binance pair, falls back to Twelve Data
// (forex/binary pairs - history depth limited by the Twelve Data plan).
async function runAnalysis(symbolRaw) {
  const symbol = symbolRaw.toUpperCase();
  let candles;
  let market;
  try {
    candles = await hist.fetchBinanceHistory(symbol, '1h', MAX_CANDLES);
    if (!candles || candles.length === 0) throw new Error('empty');
    market = 'crypto (Binance)';
  } catch (err) {
    candles = await hist.fetchTwelveDataHistory(symbol, '1h', MAX_CANDLES);
    market = 'forex/binary (Twelve Data)';
  }
  if (!candles || candles.length < 200) {
    throw new Error(
      `Not enough historical 1h candles for ${symbol} (got ${candles ? candles.length : 0}). Need at least 200.`
    );
  }
  const result = hist.analyzeHistory(candles, CHECKPOINTS_HOURS);
  const best = hist.recommendCheckpoint(result.checkpoints);
  return { symbol, market, ...result, best };
}

function formatResult(r) {
  const lines = [
    `*${r.symbol} - Historical Pattern Analysis* (${r.market})`,
    '',
    `Data used: ${r.overall.totalCandles} hourly candles`,
    `Overall: ${r.overall.greenPct}% green candles, ${r.overall.redPct}% red candles (avg body ${r.overall.avgBodyPct}%)`,
    '',
    `Current market state: \`${r.currentState}\` (trend|RSI zone|volatility|last candle color)`,
    `Similar past moments found: ${r.sampleSize}`,
    '',
    'What happened after similar moments historically:',
    ...r.checkpoints.map((c) => {
      if (!c.sampleSize) return `- ${formatHours(c.candlesAhead)}: not enough matching samples`;
      const dir = c.abovePct >= c.belowPct ? 'ABOVE' : 'BELOW';
      const pct = Math.max(c.abovePct, c.belowPct);
      return `- ${formatHours(c.candlesAhead)}: price stayed ${dir} entry ${pct}% of the time (n=${c.sampleSize})`;
    }),
    '',
  ];

  if (r.best && r.best.sampleSize > 0) {
    const dir = r.best.abovePct >= r.best.belowPct ? 'ABOVE' : 'BELOW';
    const pct = Math.max(r.best.abovePct, r.best.belowPct);
    const lowSample = r.best.sampleSize < 30;
    lines.push(
      `📌 Advice: **${formatHours(r.best.candlesAhead)}** had the strongest historical edge in similar setups -`,
      `price stayed ${dir} entry ${pct}% of the time (n=${r.best.sampleSize}${lowSample ? ', small sample - treat with caution' : ''}).`
    );
  } else {
    lines.push('Not enough historical matches of the current state to recommend a duration with confidence.');
  }

  lines.push(
    '',
    '_Historical frequency, not a guarantee - past patterns repeating is not certain. Analysis only, not financial advice._'
  );
  return lines.join('\n');
}

// Needs the raw Discord `message` object (not just a string reply) so it
// can edit its own status message with a live elapsed-time counter while
// it fetches + crunches potentially thousands of candles.
async function handleHistoryCommand(message, argText) {
  const symbol = (argText || '').trim();
  if (!symbol) {
    await message.reply('Usage: !history BTCUSDT  (or !history EURUSD for forex/binary pairs)');
    return;
  }

  const startedAt = Date.now();
  const elapsedSec = () => ((Date.now() - startedAt) / 1000).toFixed(1);
  const statusText = () =>
    `📚 Pulling historical data for **${symbol.toUpperCase()}** and scanning for similar past setups... (${elapsedSec()}s)`;

  let statusMsg;
  try {
    statusMsg = await message.reply(statusText());
  } catch (err) {
    logger.error('history: could not send initial status message:', err.message);
    return;
  }

  const timer = setInterval(() => {
    statusMsg.edit(statusText()).catch(() => {});
  }, 2000);

  try {
    const result = await runAnalysis(symbol);
    clearInterval(timer);
    await statusMsg.edit(`${formatResult(result)}\n\n⏱️ Took ${elapsedSec()}s.`);
  } catch (err) {
    clearInterval(timer);
    logger.error('history command failed:', err.message);
    await statusMsg
      .edit(`❌ Could not run historical analysis for ${symbol}: ${err.message} (after ${elapsedSec()}s)`)
      .catch(() => {});
  }
}

module.exports = { handleHistoryCommand };
