const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

// Public market-data endpoints only need an API key for higher rate limits;
// none of the calls below place orders or touch account/trading endpoints.
const SPOT_BASE = 'https://api.binance.com';
const FUTURES_BASE = 'https://fapi.binance.com';

const http = axios.create({
  timeout: 10000,
  headers: config.binance.apiKey ? { 'X-MBX-APIKEY': config.binance.apiKey } : {},
});

async function get(base, path, params = {}) {
  const url = `${base}${path}`;
  try {
    const { data } = await http.get(url, { params });
    return data;
  } catch (err) {
    const msg = err.response ? JSON.stringify(err.response.data) : err.message;
    logger.error(`Binance request failed: ${url} -> ${msg}`);
    throw new Error(`Binance API error (${path}): ${msg}`);
  }
}

// Klines: [openTime, open, high, low, close, volume, closeTime, quoteVolume, trades, takerBuyBase, takerBuyQuote, ignore]
function mapKlines(raw) {
  return raw.map((k) => ({
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    closeTime: k[6],
    quoteVolume: parseFloat(k[7]),
    trades: k[8],
  }));
}

async function getSpotKlines(symbol, interval, limit = 250) {
  const raw = await get(SPOT_BASE, '/api/v3/klines', { symbol, interval, limit });
  return mapKlines(raw);
}

async function getFuturesKlines(symbol, interval, limit = 250) {
  const raw = await get(FUTURES_BASE, '/fapi/v1/klines', { symbol, interval, limit });
  return mapKlines(raw);
}

async function getSpotOrderBook(symbol, limit = 100) {
  return get(SPOT_BASE, '/api/v3/depth', { symbol, limit });
}

async function getFuturesOpenInterest(symbol) {
  // current OI snapshot
  const current = await get(FUTURES_BASE, '/fapi/v1/openInterest', { symbol });
  // OI history (5m granularity) for trend
  const hist = await get(FUTURES_BASE, '/futures/data/openInterestHist', {
    symbol,
    period: '15m',
    limit: 20,
  }).catch(() => []);
  return { current: parseFloat(current.openInterest), history: hist };
}

async function getFundingRate(symbol) {
  const data = await get(FUTURES_BASE, '/fapi/v1/premiumIndex', { symbol });
  return {
    lastFundingRate: parseFloat(data.lastFundingRate),
    markPrice: parseFloat(data.markPrice),
    nextFundingTime: data.nextFundingTime,
  };
}

async function getSpotTickerPrice(symbol) {
  const data = await get(SPOT_BASE, '/api/v3/ticker/price', { symbol });
  return parseFloat(data.price);
}

async function get24hStats(symbol) {
  const data = await get(SPOT_BASE, '/api/v3/ticker/24hr', { symbol });
  return {
    volume: parseFloat(data.volume),
    quoteVolume: parseFloat(data.quoteVolume),
    priceChangePercent: parseFloat(data.priceChangePercent),
  };
}

module.exports = {
  getSpotKlines,
  getFuturesKlines,
  getSpotOrderBook,
  getFuturesOpenInterest,
  getFundingRate,
  getSpotTickerPrice,
  get24hStats,
};
