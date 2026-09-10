const signalEngine = require('../services/signalEngine');
const { formatSignalMessage } = require('../utils/formatting');
const logger = require('../utils/logger');

function normalizePair(raw) {
  if (!raw) return null;
  const p = raw.trim().toUpperCase();
  return /^[A-Z0-9]{5,15}$/.test(p) ? p : null;
}

async function handleSignalCommand(argText) {
  const pair = normalizePair(argText);
  if (!pair) {
    return 'Usage: !signal BTCUSDT\n(Provide a valid Binance pair symbol, e.g. BTCUSDT, ETHUSDT)';
  }

  try {
    const signal = await signalEngine.generateSignal(pair);
    return formatSignalMessage(signal);
  } catch (err) {
    logger.error('signal command failed:', err.message);
    return `Could not generate a signal for ${pair}: ${err.message}`;
  }
}

module.exports = { handleSignalCommand };
