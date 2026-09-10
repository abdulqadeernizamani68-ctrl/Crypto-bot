const { EMA, RSI, MACD, ATR } = require('technicalindicators');

function closes(candles) {
  return candles.map((c) => c.close);
}

function ema(candles, period) {
  const values = EMA.calculate({ period, values: closes(candles) });
  return values.length ? values[values.length - 1] : null;
}

function emaSeries(candles, period) {
  return EMA.calculate({ period, values: closes(candles) });
}

function rsi(candles, period = 14) {
  const values = RSI.calculate({ period, values: closes(candles) });
  return values.length ? values[values.length - 1] : null;
}

function rsiSeries(candles, period = 14) {
  return RSI.calculate({ period, values: closes(candles) });
}

function macd(candles) {
  const values = MACD.calculate({
    values: closes(candles),
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  return values.length ? values[values.length - 1] : null;
}

function macdSeries(candles) {
  return MACD.calculate({
    values: closes(candles),
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
}

function atr(candles, period = 14) {
  const values = ATR.calculate({
    period,
    high: candles.map((c) => c.high),
    low: candles.map((c) => c.low),
    close: candles.map((c) => c.close),
  });
  return values.length ? values[values.length - 1] : null;
}

module.exports = { ema, emaSeries, rsi, rsiSeries, macd, macdSeries, atr };
