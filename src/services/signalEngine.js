const config = require('../config');
const binance = require('./binance');
const analysis = require('./analysis');
const indicators = require('./indicators');
const regimeSvc = require('./regime');
const scoringSvc = require('./scoring');
const store = require('./redisStore');
const newsFilter = require('./newsFilter');
const invalidationAnalysis = require('./invalidationAnalysis');
const evEngine = require('./expectedValue');
const gradingSvc = require('./grading');
const riskEngine = require('./riskEngine');
const marketAnomaly = require('./marketAnomaly');
const logger = require('../utils/logger');

const CATEGORIES = [
  'trend', 'momentum', 'volatility', 'volume', 'structure',
  'supportResistance', 'breakoutRetest', 'liquidity', 'orderbook',
  'openInterest', 'funding', 'trapRisk', 'smc',
];

const CATEGORY_LABELS = {
  trend: 'Trend alignment',
  momentum: 'Momentum',
  volatility: 'Volatility conditions',
  volume: 'Volume',
  structure: 'Market structure',
  supportResistance: 'Support/Resistance',
  breakoutRetest: 'Breakout/Retest',
  liquidity: 'Liquidity',
  orderbook: 'Order book pressure',
  openInterest: 'Open interest',
  funding: 'Funding rate',
  trapRisk: 'Trap/manipulation risk',
  smc: 'Smart Money Concepts',
};

async function fetchAllData(pair) {
  const tfEntries = await Promise.all(
    config.timeframes.map(async (tf) => {
      try {
        return [tf, await binance.getSpotKlines(pair, tf, 260)];
      } catch (err) {
        logger.warn(`fetchAllData: ${tf} klines failed for ${pair}: ${err.message}`);
        return [tf, null];
      }
    })
  );
  const timeframeCandles = Object.fromEntries(tfEntries);

  const [futures15m, orderBook, openInterest, funding, ticker24h] = await Promise.all([
    binance.getFuturesKlines(pair, '15m', 260).catch(() => null),
    binance.getSpotOrderBook(pair, 100).catch(() => null),
    binance.getFuturesOpenInterest(pair).catch(() => null),
    binance.getFundingRate(pair).catch(() => null),
    binance.get24hStats(pair).catch(() => null),
  ]);

  return { timeframeCandles, futures15m, orderBook, openInterest, funding, ticker24h };
}

// ---- Requirement 4: Data Failure Protection ----
// Core inputs (15m + 1h candles, order book) are mandatory - anything
// missing, too short, or stale means the bot cannot reliably analyze the
// pair right now, so it returns NO TRADE - DATA UNAVAILABLE rather than
// guessing or generating a signal off partial data. Futures-only fields
// (OI, funding, futures volume) are treated as optional - useful when
// present, but their absence alone should not block spot-based analysis.
function validateCoreData(data) {
  const problems = [];
  const c15 = data.timeframeCandles['15m'];
  const c1h = data.timeframeCandles['1h'];

  if (!c15 || c15.length < 60) problems.push('15m candle data missing or incomplete');
  if (!c1h || c1h.length < 60) problems.push('1h candle data missing or incomplete');
  if (!data.orderBook || !data.orderBook.bids?.length || !data.orderBook.asks?.length) {
    problems.push('order book data missing or empty');
  }

  if (c15 && c15.length) {
    const lastCloseTime = c15[c15.length - 1].closeTime;
    const staleMs = Date.now() - lastCloseTime;
    if (staleMs > 5 * 60 * 1000) problems.push('market data appears delayed/stale');
  }

  return problems;
}

function dataUnavailableSignal(pair, problems) {
  return {
    id: store.newSignalId(pair),
    pair,
    direction: 'NO TRADE',
    entry: null,
    stopLoss: null,
    takeProfit: null,
    riskReward: null,
    confidence: 0,
    signalTime: Date.now(),
    validityMinutes: 0,
    regime: { trend: 'UNKNOWN', volatility: 'UNKNOWN' },
    categoryScores: {},
    reason: ['NO TRADE - DATA UNAVAILABLE', ...problems],
    topReasons: ['NO TRADE - DATA UNAVAILABLE', ...problems],
    topConfirmations: [],
    topInvalidationFactors: problems,
    expectedValue: null,
    grade: 'D',
    riskAssessment: null,
    marketConditions: null,
    trapWarnings: [],
    status: 'NO_TRADE',
    highestPriceAfter: null,
    lowestPriceAfter: null,
    mfe: 0,
    mae: 0,
    result: null,
  };
}

function computeEntrySlTp(direction, entry, atr15m, srInfo, minRR) {
  const slDistance = Math.max(atr15m * 1.5, entry * 0.001); // floor to avoid zero-width stops
  const targetRR = Math.max(minRR, 2);
  let tpDistance = slDistance * targetRR;

  let stopLoss, takeProfit;
  if (direction === 'BUY') {
    stopLoss = entry - slDistance;
    const res = srInfo.resistance;
    if (res && res.price > entry) {
      const levelDist = res.price - entry;
      if (levelDist > slDistance * minRR * 0.8) {
        tpDistance = Math.min(tpDistance * 1.4, levelDist); // prefer a real level, capped
      }
    }
    takeProfit = entry + tpDistance;
  } else {
    stopLoss = entry + slDistance;
    const sup = srInfo.support;
    if (sup && sup.price < entry) {
      const levelDist = entry - sup.price;
      if (levelDist > slDistance * minRR * 0.8) {
        tpDistance = Math.min(tpDistance * 1.4, levelDist);
      }
    }
    takeProfit = entry - tpDistance;
  }

  const actualRisk = Math.abs(entry - stopLoss);
  const actualReward = Math.abs(takeProfit - entry);
  const riskReward = actualRisk > 0 ? actualReward / actualRisk : 0;

  return { stopLoss, takeProfit, riskReward: Number(riskReward.toFixed(2)), slDistance, tpDistance };
}

function validityMinutes(regime) {
  if (regime.trend === 'TRENDING' && regime.volatility !== 'HIGH_VOLATILITY') return 90;
  if (regime.trend === 'RANGING') return 45;
  if (regime.volatility === 'HIGH_VOLATILITY') return 30;
  return 60;
}

// ---- Requirement 9: Explainable Signals ----
// Builds a short, data-derived breakdown of why the signal fired (or
// didn't), so every signal can be reviewed/debugged later without re-running
// the whole analysis. Kept to a handful of top items rather than a full dump.
function buildExplanation({ combined, direction, trapFindings, marketConditions, baseReasons }) {
  const tradeSign = direction === 'BUY' ? 1 : direction === 'SELL' ? -1 : 0;
  const entries = Object.entries(combined.breakdown || {});

  const confirmations = entries
    .filter(([, v]) => tradeSign !== 0 && Math.sign(v.score) === tradeSign && Math.abs(v.score) > 0.15)
    .sort((a, b) => Math.abs(b[1].score) - Math.abs(a[1].score))
    .slice(0, 4)
    .map(([cat, v]) => `${CATEGORY_LABELS[cat] || cat} (score ${v.score})`);

  const invalidations = entries
    .filter(([, v]) => tradeSign !== 0 && Math.sign(v.score) === -tradeSign && Math.abs(v.score) > 0.15)
    .sort((a, b) => Math.abs(b[1].score) - Math.abs(a[1].score))
    .slice(0, 4)
    .map(([cat, v]) => `${CATEGORY_LABELS[cat] || cat} disagreed (score ${v.score})`);

  trapFindings.forEach((f) => invalidations.push(`${f.type}: ${f.note}`));
  if (marketConditions?.abnormal) {
    invalidations.push(`Abnormal market conditions detected (${marketConditions.severity})`);
  }

  const topReasons = direction === 'NO TRADE'
    ? [...baseReasons]
    : [
        `Live direction: ${direction} at ${combined.confidence}% confidence`,
        `${combined.alignedCategories}/${combined.totalCategories} categories aligned`,
      ];

  return {
    topReasons: topReasons.slice(0, 5),
    topConfirmations: confirmations,
    topInvalidationFactors: invalidations.slice(0, 5),
    featureImportance: computeFeatureImportance(combined.breakdown),
  };
}

// ---- Requirement 14: Feature Importance ----
// Ranks every category by the actual magnitude of its weighted contribution
// to the final score - this is exact and transparent (the scoring engine IS
// a weighted sum, see scoring.js), not an approximation of a black-box
// model the way SHAP values would be for a real ML model.
function computeFeatureImportance(breakdown) {
  const entries = Object.entries(breakdown || {}).map(([cat, v]) => {
    const contribution = v.score * (v.regimeWeight ?? 1);
    return { category: CATEGORY_LABELS[cat] || cat, score: v.score, contribution: Number(contribution.toFixed(3)) };
  });
  const totalMagnitude = entries.reduce((a, e) => a + Math.abs(e.contribution), 0) || 1;
  return entries
    .map((e) => ({ ...e, importancePct: Number(((Math.abs(e.contribution) / totalMagnitude) * 100).toFixed(1)) }))
    .sort((a, b) => b.importancePct - a.importancePct);
}

// ---- Direction & risk decision, isolated from data-fetch/scoring so the
// control flow above stays flat and readable instead of nested if/else. ----
async function decideDirection({ pair, combined, marketConditions, currentPrice, atr15m, supportResistance, riskAssessment, anomalies }) {
  const reason = [];
  let effectiveConfidence = combined.confidence;

  // ---- Institutional Risk Engine: overrides everything else. ----
  if (!riskAssessment.allowed) {
    reason.push('NO TRADE - risk protection active', ...riskAssessment.reasons);
    return { direction: 'NO TRADE', effectiveConfidence, reason, entrySlTp: null, ev: null, grade: 'D' };
  }

  // ---- Market Anomaly Detection: an EXTREME flag (flash move, extreme
  // volatility percentile) blocks new trades until conditions normalize. ----
  const extremeAnomaly = anomalies.flags.find((f) => f.severity === 'EXTREME');
  if (extremeAnomaly) {
    reason.push(`NO TRADE - market anomaly detected: ${extremeAnomaly.note}`);
    return { direction: 'NO TRADE', effectiveConfidence, reason, entrySlTp: null, ev: null, grade: 'D' };
  }

  // ---- Requirement 1: News & Event Filter ----
  if (marketConditions.forceNoTrade) {
    const causes = [
      marketConditions.priceShock ? 'sudden volatility shock' : null,
      marketConditions.newsHits.length ? 'major news event' : null,
    ].filter(Boolean).join(', ') || 'severe conditions';
    reason.push(`NO TRADE - abnormal market conditions detected (${causes})`);
    return { direction: 'NO TRADE', effectiveConfidence, reason, entrySlTp: null, ev: null, grade: 'D' };
  }

  if (marketConditions.abnormal && marketConditions.confidencePenaltyPct > 0) {
    effectiveConfidence = Math.round(effectiveConfidence * (1 - marketConditions.confidencePenaltyPct / 100));
    reason.push(`Confidence reduced ${marketConditions.confidencePenaltyPct}% due to abnormal market conditions`);
  }

  const meetsConfidence = effectiveConfidence >= config.engine.minConfidence;
  const meetsAlignment = combined.alignedCategories >= config.engine.minAlignedCategories;
  const hasDirection = combined.direction === 'BUY' || combined.direction === 'SELL';

  if (!meetsConfidence || !meetsAlignment || !hasDirection) {
    if (!meetsConfidence) reason.push(`Confidence ${effectiveConfidence}% below required ${config.engine.minConfidence}%`);
    if (!meetsAlignment) reason.push(`Only ${combined.alignedCategories}/${combined.totalCategories} categories aligned (need ${config.engine.minAlignedCategories})`);
    if (!hasDirection) reason.push('No clear directional consensus across analyses');
    return { direction: 'NO TRADE', effectiveConfidence, reason, entrySlTp: null, ev: null, grade: 'D' };
  }

  // ---- Requirement 2: Duplicate Signal Protection ----
  const activeDuplicate = await store.getActiveSignal(pair, combined.direction);
  if (activeDuplicate) {
    reason.push(
      `Duplicate signal protection: an active ${combined.direction} signal for ${pair} ` +
      `is already open (id ${activeDuplicate.id}) - waiting for it to complete, expire, or invalidate`
    );
    return { direction: 'NO TRADE', effectiveConfidence, reason, entrySlTp: null, ev: null, grade: 'D' };
  }

  const entrySlTp = computeEntrySlTp(combined.direction, currentPrice, atr15m, supportResistance, config.engine.minRiskReward);
  if (entrySlTp.riskReward < config.engine.minRiskReward) {
    reason.push('Risk:Reward below minimum threshold after applying structure-based targets');
    return { direction: 'NO TRADE', effectiveConfidence, reason, entrySlTp: null, ev: null, grade: 'D' };
  }

  // ---- Expected Value Engine: reject negative-EV setups even if confidence
  // and alignment both passed - a high win-rate at a bad RR (or vice versa)
  // can still be a losing bet over time. ----
  const ev = evEngine.computeExpectedValue(effectiveConfidence, entrySlTp.riskReward);
  if (!ev.positive) {
    reason.push(`Negative expected value (${ev.expectedValueR}R) - setup rejected despite passing confidence/alignment`);
    return { direction: 'NO TRADE', effectiveConfidence, reason, entrySlTp: null, ev, grade: 'D' };
  }

  // ---- Signal Quality Grading: only configured grades (default A+, A) are
  // allowed to actually fire; everything else becomes NO TRADE. ----
  const grade = gradingSvc.gradeSignal({
    confidence: effectiveConfidence,
    expectedValueR: ev.expectedValueR,
    alignedCategories: combined.alignedCategories,
    totalCategories: combined.totalCategories,
  });
  if (!config.engine.allowedGrades.includes(grade)) {
    reason.push(`Setup graded ${grade} - below minimum required grade (${config.engine.allowedGrades.join('/')})`);
    return { direction: 'NO TRADE', effectiveConfidence, reason, entrySlTp: null, ev, grade };
  }

  return { direction: combined.direction, effectiveConfidence, reason, entrySlTp, ev, grade };
}

async function generateSignal(pair, { persist = true } = {}) {
  const data = await fetchAllData(pair);

  const dataProblems = validateCoreData(data);
  if (dataProblems.length) {
    logger.warn(`generateSignal: data unavailable for ${pair}: ${dataProblems.join('; ')}`);
    return dataUnavailableSignal(pair, dataProblems);
  }

  const { timeframeCandles } = data;
  const currentPrice = timeframeCandles['15m'][timeframeCandles['15m'].length - 1].close;
  const regime = regimeSvc.detectRegime(timeframeCandles['1h']);
  const regimeWeights = regimeSvc.getRegimeWeights(regime);
  const adaptiveWeights = await store.getAllFilterPerformance(CATEGORIES);

  const trend = analysis.scoreTrend(timeframeCandles);
  const momentum = analysis.scoreMomentum(timeframeCandles);
  const volatility = analysis.scoreVolatility(timeframeCandles['15m'], regime);
  const volume = analysis.scoreVolume(timeframeCandles['15m'], data.futures15m);
  const structure = analysis.scoreStructure(timeframeCandles['1h']);
  const supportResistance = analysis.scoreSupportResistance(timeframeCandles['1h'], currentPrice);
  const breakoutRetest = analysis.scoreBreakoutRetest(timeframeCandles['1h']);
  const { liquidity, orderbook } = analysis.scoreLiquidityAndOrderBook(data.orderBook);
  const openInterest = analysis.scoreOpenInterest(data.openInterest, trend.score);
  const funding = analysis.scoreFunding(data.funding);
  const trapRisk = analysis.scoreTrapRisk(timeframeCandles['1h'], breakoutRetest.detail, data.orderBook);
  const smc = analysis.scoreSMC(timeframeCandles['1h']);

  const categoryScores = {
    trend: { score: trend.score },
    momentum: { score: momentum.score },
    volatility: { score: volatility.score },
    volume: { score: volume.score },
    structure: { score: structure.score },
    supportResistance: { score: supportResistance.score },
    breakoutRetest: { score: breakoutRetest.score },
    liquidity: { score: liquidity.score },
    orderbook: { score: orderbook.score },
    openInterest: { score: openInterest.score },
    funding: { score: funding.score },
    trapRisk: { score: trapRisk.score },
    smc: { score: smc.score },
  };

  const combined = scoringSvc.combineScores(
    categoryScores,
    regimeWeights,
    adaptiveWeights,
    config.engine.adaptiveMinSamples
  );

  const atr15m = indicators.atr(timeframeCandles['15m'], 14) || currentPrice * 0.002;

  // ---- Requirement 1: News & Event Filter (abnormal vs normal conditions) ----
  const marketConditions = await newsFilter.assessMarketConditions({
    candles15m: timeframeCandles['15m'],
    atr: atr15m,
    regime,
    pair,
  });

  // ---- Institutional Risk Engine input: real closed-signal history ----
  const allSignalsForRisk = await store.getAllSignals();
  const riskAssessment = riskEngine.assessRisk(allSignalsForRisk);

  // ---- Market Anomaly Detection ----
  const anomalies = marketAnomaly.detectAnomalies({ candles15m: timeframeCandles['15m'], atrValue: atr15m, regime });

  const { direction, effectiveConfidence, reason, entrySlTp, ev, grade } = await decideDirection({
    pair, combined, marketConditions, currentPrice, atr15m, supportResistance, riskAssessment, anomalies,
  });

  const explanation = buildExplanation({
    combined, direction, trapFindings: [...trapRisk.findings, ...smc.findings], marketConditions, baseReasons: reason,
  });

  const signal = {
    id: store.newSignalId(pair),
    pair,
    direction,
    entry: direction !== 'NO TRADE' ? currentPrice : null,
    stopLoss: entrySlTp ? Number(entrySlTp.stopLoss.toFixed(6)) : null,
    takeProfit: entrySlTp ? Number(entrySlTp.takeProfit.toFixed(6)) : null,
    riskReward: entrySlTp ? entrySlTp.riskReward : null,
    confidence: effectiveConfidence,
    liveConfidence: combined.liveConfidence,
    calibrationFactor: combined.calibrationFactor,
    expectedValue: ev,
    grade,
    riskAssessment,
    signalTime: Date.now(),
    validityMinutes: validityMinutes(regime),
    regime,
    categoryScores: combined.breakdown,
    reason,
    topReasons: explanation.topReasons,
    topConfirmations: explanation.topConfirmations,
    topInvalidationFactors: explanation.topInvalidationFactors,
    featureImportance: explanation.featureImportance,
    smc: { bosChoch: smc.bosChoch, premiumDiscount: smc.premiumDiscount },
    marketConditions: {
      abnormal: marketConditions.abnormal,
      severity: marketConditions.severity,
      priceShock: marketConditions.priceShock,
      newsHits: marketConditions.newsHits,
    },
    trapWarnings: trapRisk.findings,
    anomalies: anomalies.flags,
    paper: config.engine.paperMode,
    // tracking fields, filled in by the tracker job later
    status: direction === 'NO TRADE' ? 'NO_TRADE' : 'OPEN',
    highestPriceAfter: direction !== 'NO TRADE' ? currentPrice : null,
    lowestPriceAfter: direction !== 'NO TRADE' ? currentPrice : null,
    mfe: 0,
    mae: 0,
    result: null,
  };

  if (direction !== 'NO TRADE') {
    // Extended structural invalidation level + whatever real recovery-odds
    // history has accumulated so far for this pair+direction (see
    // invalidationAnalysis.js - reads only, never guesses a number).
    signal.extendedInvalidation = await invalidationAnalysis.buildExtendedInvalidation({
      direction,
      entry: currentPrice,
      stopLoss: signal.stopLoss,
      candles4h: timeframeCandles['4h'],
      pair,
    }).catch((err) => {
      logger.warn(`extendedInvalidation failed for ${pair}: ${err.message}`);
      return null;
    });

    if (persist) {
      await store.saveNewSignal(signal);
    }
  }

  return signal;
}

module.exports = { generateSignal, CATEGORIES };
