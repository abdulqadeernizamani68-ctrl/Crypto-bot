const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

const http = axios.create({ baseURL: config.twelvedata.baseUrl, timeout: 10000 });

function normalizeSymbol(raw) {
  // Accepts "EURUSD", "EUR/USD", "BTCUSD", "BTC/USD" etc.
  const clean = raw.trim().toUpperCase().replace(/\s+/g, '');
  if (clean.includes('/')) return clean;
  if (clean.length === 6) return `${clean.slice(0, 3)}/${clean.slice(3)}`;
  // Common crypto quote currencies
  const quotes = ['USDT', 'USD', 'EUR', 'BTC'];
  for (const q of quotes) {
    if (clean.endsWith(q) && clean.length > q.length) {
      return `${clean.slice(0, clean.length - q.length)}/${q}`;
    }
  }
  return clean;
}

async function getTimeSeries(symbol, interval = '1min', outputsize = 120) {
  if (!config.twelvedata.apiKey) {
    throw new Error('TWELVEDATA_API_KEY is not set - binary signals need it (see .env.example)');
  }
  const { data } = await http.get('/time_series', {
    params: { symbol: normalizeSymbol(symbol), interval, outputsize, apikey: config.twelvedata.apiKey },
  });
  if (data.status === 'error' || !data.values) {
    throw new Error(`Twelve Data error for ${symbol}: ${data.message || 'no values returned'}`);
  }
  // Twelve Data returns most-recent-first; reverse to chronological (oldest -> newest).
  return data.values
    .map((v) => ({
      time: new Date(v.datetime).getTime(),
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
    }))
    .reverse();
}

async function getCurrentPrice(symbol) {
  if (!config.twelvedata.apiKey) {
    throw new Error('TWELVEDATA_API_KEY is not set');
  }
  const { data } = await http.get('/price', {
    params: { symbol: normalizeSymbol(symbol), apikey: config.twelvedata.apiKey },
  });
  if (!data.price) throw new Error(`Twelve Data error for ${symbol}: ${data.message || 'no price returned'}`);
  return parseFloat(data.price);
}

module.exports = { normalizeSymbol, getTimeSeries, getCurrentPrice };
