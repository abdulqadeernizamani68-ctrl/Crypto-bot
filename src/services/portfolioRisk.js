const binance = require('./binance');
const store = require('./redisStore');
const logger = require('../utils/logger');

function pearsonCorrelation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 5) return null;
  const av = a.slice(-n);
  const bv = b.slice(-n);
  const meanA = av.reduce((x, y) => x + y, 0) / n;
  const meanB = bv.reduce((x, y) => x + y, 0) / n;
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < n; i++) {
    const da = av[i] - meanA;
    const db = bv[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  return den > 0 ? num / den : null;
}

async function getReturnsSeries(pair) {
  const candles = await binance.getSpotKlines(pair, '1h', 100).catch(() => []);
  const closes = candles.map((c) => c.close);
  const returns = [];
  for (let i = 1; i < closes.length; i++) returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  return returns;
}

// Real pairwise correlation across whatever pairs are CURRENTLY open, using
// actual recent hourly returns - not a "these are both majors so they must
// correlate" guess.
async function assessPortfolioRisk() {
  const openCrypto = await store.getOpenSignals();
  const uniquePairs = [...new Set(openCrypto.map((s) => s.pair))];

  const exposureByDirection = openCrypto.reduce(
    (acc, s) => {
      acc[s.direction] = (acc[s.direction] || 0) + 1;
      return acc;
    },
    {}
  );

  let correlationRisk = null;
  if (uniquePairs.length >= 2) {
    const returnsByPair = {};
    for (const p of uniquePairs) {
      // eslint-disable-next-line no-await-in-loop
      returnsByPair[p] = await getReturnsSeries(p).catch((err) => {
        logger.warn(`portfolioRisk: couldn't fetch returns for ${p}: ${err.message}`);
        return [];
      });
    }
    const pairs = [];
    for (let i = 0; i < uniquePairs.length; i++) {
      for (let j = i + 1; j < uniquePairs.length; j++) {
        const corr = pearsonCorrelation(returnsByPair[uniquePairs[i]], returnsByPair[uniquePairs[j]]);
        if (corr != null) pairs.push({ pairA: uniquePairs[i], pairB: uniquePairs[j], correlation: Number(corr.toFixed(2)) });
      }
    }
    const highCorrelation = pairs.filter((p) => Math.abs(p.correlation) >= 0.7);
    correlationRisk = {
      pairwise: pairs,
      highCorrelationPairs: highCorrelation,
      flagged: highCorrelation.length > 0,
    };
  }

  return {
    openPositions: openCrypto.length,
    uniquePairs,
    exposureByDirection,
    correlationRisk,
    concentrationWarning:
      openCrypto.length >= 3 && Object.values(exposureByDirection).some((c) => c === openCrypto.length)
        ? `All ${openCrypto.length} open positions are ${Object.keys(exposureByDirection)[0]} - no directional diversification right now`
        : null,
  };
}

module.exports = { assessPortfolioRisk, pearsonCorrelation };
