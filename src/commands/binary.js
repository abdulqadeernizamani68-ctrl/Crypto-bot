const binaryEngine = require('../services/binaryEngine');
const binaryStore = require('../services/binaryStore');
const { formatBinarySignalMessage } = require('../utils/formatting');
const logger = require('../utils/logger');

// Usage: !binary EURUSD 5   (symbol, duration in minutes)
function parseArgs(argText) {
  const parts = (argText || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  const symbol = parts[0].toUpperCase();
  const duration = parseInt(parts[1], 10);
  if (!symbol || !Number.isFinite(duration) || duration <= 0) return null;
  return { symbol, duration };
}

async function handleBinaryCommand(argText) {
  const parsed = parseArgs(argText);
  if (!parsed) {
    return 'Usage: !binary EURUSD 5\n(symbol, then expiry duration in minutes, e.g. !binary BTCUSD 15)';
  }

  try {
    const signal = await binaryEngine.generateBinarySignal(parsed.symbol, parsed.duration);
    const id = binaryStore.newId(signal.symbol);
    await binaryStore.saveNew({ ...signal, id, status: 'OPEN', result: null });
    return formatBinarySignalMessage(signal);
  } catch (err) {
    logger.error('binary command failed:', err.message);
    return `Could not generate a binary signal for ${parsed.symbol}: ${err.message}`;
  }
}

module.exports = { handleBinaryCommand };
