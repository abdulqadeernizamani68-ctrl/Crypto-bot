// Detects abnormal / major-market-moving conditions from two independent
// sources, so the bot never depends solely on an external API being up:
//
// 1) LIVE PRICE ACTION (always available - no external dependency). A
//    sudden volatility shock is detected directly from candles already
//    fetched for this request, by comparing the latest candle's true range
//    to its own ATR baseline and to the regime's ATR percentile. This
//    catches flash crashes, exchange-hack dumps, and violent reactions to
//    news (ETF decisions, macro prints) even if no news source has reported
//    on it yet.
//
// 2) EXTERNAL NEWS (best-effort, optional). If CRYPTOPANIC_API_KEY is set,
//    recent "hot" crypto news is scanned for hack/exploit, ETF-decision, and
//    high-impact macro keywords. If no key is configured, or the request
//    fails for any reason, this source is skipped silently - the bot still
//    runs on price-action-based detection alone and never blocks a signal
//    on an external dependency it can't guarantee is up.

const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

const HACK_KEYWORDS = ['hack', 'exploit', 'drain', 'breach', 'stolen', 'rug pull'];
const ETF_KEYWORDS = ['etf', 'sec approv', 'sec reject', 'sec delay'];
const MACRO_KEYWORDS = ['fomc', 'interest rate', 'cpi', 'rate decision', 'nonfarm', 'fed chair'];

function detectPriceShock(candles15m, atr, regime) {
  if (!candles15m || candles15m.length < 6 || !atr) return null;
  const last = candles15m[candles15m.length - 1];
  const range = last.high - last.low;
  const rangeToAtr = atr > 0 ? range / atr : 0;

  const priorCloses = candles15m.slice(-6, -1).map((c) => c.close);
  const avgPrior = priorCloses.length ? priorCloses.reduce((a, b) => a + b, 0) / priorCloses.length : 0;
  const movePct = avgPrior > 0 ? (Math.abs(last.close - avgPrior) / avgPrior) * 100 : 0;

  const extremeVol = regime.atrPercentile !== null && regime.atrPercentile !== undefined
    && regime.atrPercentile >= config.news.extremeAtrPercentile;

  if (rangeToAtr >= 3 || movePct >= 3 || extremeVol) {
    return {
      type: 'PRICE_SHOCK',
      rangeToAtr: Number(rangeToAtr.toFixed(2)),
      movePct: Number(movePct.toFixed(2)),
      atrPercentile: regime.atrPercentile,
      severity: (rangeToAtr >= 5 || movePct >= 6) ? 'SEVERE' : 'HIGH',
    };
  }
  return null;
}

async function fetchCryptoNewsEvents() {
  if (!config.news.cryptoPanicToken) return [];
  try {
    const { data } = await axios.get('https://cryptopanic.com/api/v1/posts/', {
      params: { auth_token: config.news.cryptoPanicToken, filter: 'hot', kind: 'news' },
      timeout: 5000,
    });
    return (data && data.results) || [];
  } catch (err) {
    logger.warn('News filter: external news fetch failed, continuing on price-action detection only:', err.message);
    return [];
  }
}

function classifyNewsItems(items, windowMinutes, pair) {
  const cutoff = Date.now() - windowMinutes * 60 * 1000;
  const baseAsset = (pair || '').replace(/USDT|BUSD|USDC$/i, '').toLowerCase();
  const hits = [];
  for (const item of items) {
    const publishedAt = item.published_at ? new Date(item.published_at).getTime() : 0;
    if (publishedAt < cutoff) continue;
    const title = (item.title || '').toLowerCase();
    if (HACK_KEYWORDS.some((k) => title.includes(k))) {
      // Hack/exploit headlines only count as relevant if they name this
      // pair's base asset, or are broad enough to affect the whole market
      // (e.g. "major exchange hacked").
      if (!baseAsset || title.includes(baseAsset) || title.includes('exchange')) {
        hits.push({ type: 'EXCHANGE_HACK_OR_EXPLOIT', title: item.title });
      }
    } else if (ETF_KEYWORDS.some((k) => title.includes(k))) {
      hits.push({ type: 'ETF_DECISION', title: item.title });
    } else if (MACRO_KEYWORDS.some((k) => title.includes(k))) {
      hits.push({ type: 'HIGH_IMPACT_ECON_NEWS', title: item.title });
    }
  }
  return hits;
}

async function assessMarketConditions({ candles15m, atr, regime, pair }) {
  const priceShock = detectPriceShock(candles15m, atr, regime);

  let newsHits = [];
  if (config.news.enabled) {
    const items = await fetchCryptoNewsEvents();
    newsHits = classifyNewsItems(items, config.news.highImpactWindowMinutes, pair);
  }

  const abnormal = !!priceShock || newsHits.length > 0;
  const severe = priceShock?.severity === 'SEVERE' || newsHits.some((h) => h.type === 'EXCHANGE_HACK_OR_EXPLOIT');
  const severity = severe ? 'SEVERE' : abnormal ? 'HIGH' : 'NORMAL';

  // SEVERE conditions (flash-crash-scale shock, or a hack headline tied to
  // this asset/an exchange) force NO TRADE outright rather than merely
  // dampening confidence - per the requirement to treat abnormal conditions
  // distinctly from normal ones.
  return {
    abnormal,
    severity,
    forceNoTrade: severity === 'SEVERE',
    confidencePenaltyPct: severity === 'HIGH' ? 20 : 0,
    priceShock,
    newsHits,
  };
}

module.exports = { assessMarketConditions };
