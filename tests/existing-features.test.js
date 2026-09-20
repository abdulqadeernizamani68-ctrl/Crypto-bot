require('./helpers/stubDeps');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, run } = require('./testKit');
const { makeCandles, makeInputs } = require('./helpers/fixtures');
const { makeFakeRedis } = require('./helpers/fakeRedis');
const { makeFakeProvider } = require('../src/services/ai/fakeProvider');
const store = require('../src/services/redisStore');
const twelvedata = require('../src/services/twelvedata');
const binaryEngine = require('../src/services/binaryEngine');
const analyst = require('../src/services/ai/analyst');
const { compareAnalyses } = require('../src/services/ai/comparison');
const formatting = require('../src/utils/marketFormatting');
const { parseMarketRequest } = require('../src/services/nlu');
const { routeCommand, handleMessage } = require('../src/index');

const ROOT = path.resolve(__dirname, '..');
const FIXED_END = Date.now() - 60000;

let redis;
let tdCalls;
function resetWorld() {
  redis = makeFakeRedis();
  store.redis = redis;
  tdCalls = 0;
}
twelvedata.getTimeSeries = async (symbol, interval, n) => { tdCalls += 1; return makeCandles({ count: n, endTime: FIXED_END, seed: 11 }); };
twelvedata.getCurrentPrice = async () => { tdCalls += 1; return 1.0805; };

function makeMessage(text) {
  const log = [];
  const sent = { edit: async (content) => { log.push({ op: 'edit', content }); } };
  return {
    log,
    message: {
      author: { bot: false, tag: 't#1' },
      content: text,
      channel: { id: 'ef-chan', send: async (content) => { log.push({ op: 'channel.send', content }); } },
      reply: async (content) => { log.push({ op: 'reply', content }); return sent; },
    },
  };
}

const withoutTime = (signal) => { const { signalTime, ...rest } = signal; return rest; };

// ---------------------------------------------------------------- 12: analytics engine
test('12. fetchSignalInputs returns RAW inputs only (no indicator, score or conclusion)', async () => {
  resetWorld();
  const inputs = await binaryEngine.fetchSignalInputs('eurusd', 240);
  assert.deepStrictEqual(
    Object.keys(inputs).sort(),
    ['candles', 'duration', 'entryPrice', 'fetchSize', 'fetchedAt', 'priceSource', 'staleness', 'statsLookback', 'symbol'],
  );
  assert.strictEqual(inputs.symbol, 'EURUSD');
  assert.strictEqual(inputs.duration, 240);
  assert.strictEqual(inputs.entryPrice, 1.0805);
  assert.strictEqual(inputs.priceSource, 'live-quote');
  assert.strictEqual(inputs.candles.length, binaryEngine.requiredFetchSize(240, inputs.statsLookback));
  assert.strictEqual(tdCalls, 2);
});

test('12b. fetchSignalInputs keeps the old failure behaviour for too little data (now with a code)', async () => {
  resetWorld();
  const saved = twelvedata.getTimeSeries;
  twelvedata.getTimeSeries = async () => makeCandles({ count: 12 });
  try {
    await assert.rejects(
      () => binaryEngine.fetchSignalInputs('EURUSD', 5),
      (err) => err.code === 'INSUFFICIENT_DATA' && /Not enough recent 1-minute data for EURUSD to analyze \(got 12 candles\)/.test(err.message),
    );
    await assert.rejects(() => binaryEngine.generateBinarySignal('EURUSD', 5), /Not enough recent 1-minute data/);
  } finally { twelvedata.getTimeSeries = saved; }
});

test('12c. generateBinarySignal(symbol, minutes) still fetches internally and is IDENTICAL to the prefetched path', async () => {
  resetWorld();
  const viaInternalFetch = await binaryEngine.generateBinarySignal('EURUSD', 30);
  assert.strictEqual(tdCalls, 2, 'the old two-argument call still performs its own fetch');

  const inputs = await binaryEngine.fetchSignalInputs('EURUSD', 30);
  tdCalls = 0;
  const viaPrefetched = await binaryEngine.generateBinarySignal('EURUSD', 30, inputs);
  assert.strictEqual(tdCalls, 0, 'a prefetched snapshot means no second fetch');
  assert.deepStrictEqual(withoutTime(viaPrefetched), withoutTime(viaInternalFetch));
  ['direction', 'rawProbability', 'calibratedProbability', 'qualityLabel', 'confluenceBreakdown', 'checkpoints', 'regime', 'volatilityRegime', 'multiTimeframe', 'supportResistance', 'session', 'featureFlags']
    .forEach((k) => assert.ok(k in viaInternalFetch, `signal.${k} still present`));
});

test('12d. the pure analytics core is untouched: the signal\'s raw math equals computeSignalCore on the same candles', async () => {
  resetWorld();
  const inputs = makeInputs({ duration: 60, count: 825, seed: 5 });
  const signal = await binaryEngine.generateBinarySignal(inputs.symbol, inputs.duration, inputs);
  const core = binaryEngine.computeSignalCore(inputs.candles, inputs.entryPrice, inputs.duration, inputs.statsLookback);
  assert.strictEqual(signal.rawProbability, core.rawProbability);
  assert.strictEqual(signal.rawDirection, core.rawDirection);
  assert.strictEqual(signal.volPerMin, core.volPerMin);
  assert.deepStrictEqual(signal.checkpoints, core.checkpoints);
});

test('12e. the bot analysis still makes NO Redis writes (calibration reads only)', async () => {
  resetWorld();
  await binaryEngine.generateBinarySignal('EURUSD', 15);
  assert.deepStrictEqual(redis.writeCalls(), []);
  assert.ok(redis.readCalls().length > 0);
});

// ---------------------------------------------------------------- 12: NLU
test('12f. nlu still parses symbol / horizon / language / intent exactly as before', () => {
  const p = parseMarketRequest('EURUSD 4H');
  assert.deepStrictEqual([p.symbol, p.horizonMinutes, p.language, p.intent], ['EURUSD', 240, 'en', 'analyze']);
  assert.strictEqual(parseMarketRequest('BTCUSD 15m analysis').horizonMinutes, 15);
  assert.strictEqual(parseMarketRequest('GBP/USD 1 hour').symbol, 'GBPUSD');
  assert.strictEqual(parseMarketRequest('EURUSD analyse karo').language, 'roman-urdu');
  assert.strictEqual(parseMarketRequest('Roman Urdu mein explain karo').symbol, null);
  assert.strictEqual(parseMarketRequest('Bot aur AI ka comparison dikhao').intent, 'compare');
  assert.strictEqual(parseMarketRequest('Sirf differences batao').intent, 'differences-only');
  assert.strictEqual(parseMarketRequest('Data quality check karo GBPUSD').intent, 'dataquality');
  assert.strictEqual(parseMarketRequest('Is analysis ki reasoning batao').intent, 'reasoning');
  assert.strictEqual(parseMarketRequest('EURUSD compact').compact, true);
});

// ---------------------------------------------------------------- 12: other commands
test('12g. "!binary" is unchanged: replies (never edits), no WAITING message, same text', async () => {
  resetWorld();
  const expected = await routeCommand('!binary EURUSD 5', 'ef-chan');
  resetWorld();
  const { message, log } = makeMessage('!binary EURUSD 5');
  await handleMessage(message);
  assert.strictEqual(log[0].op, 'reply');
  assert.ok(!log.some((l) => l.op === 'edit'), 'no edit - there is no WAITING message for !binary');
  assert.ok(!log.some((l) => l.content.includes('WAITING')));
  assert.match(log[0].content, /Direction: \*(UP|DOWN|NO_TRADE)\*/);
  assert.ok(log.every((l, i) => i === 0 || l.op === 'channel.send'), 'only overflow continues in follow-up chunks');
  assert.ok(log.every((l) => l.content.length <= 2000));
  // nothing lost or altered by delivery (whitespace at chunk boundaries aside)
  assert.strictEqual(log.map((l) => l.content).join('\n').replace(/\s+/g, ' '), expected.replace(/\s+/g, ' '));
});

test('12g2. any reply that already fits in one Discord message (<= 2000 chars) is still sent as exactly one message', async () => {
  for (const len of [10, 1500, 1999, 2000]) {
    const { message, log } = makeMessage('!binary anything');
    // eslint-disable-next-line no-await-in-loop
    await handleMessage(message, { routeCommand: async () => 'z'.repeat(len) });
    assert.deepStrictEqual(log.map((l) => l.op), ['reply'], `length ${len}`);
    assert.strictEqual(log[0].content.length, len);
  }
});

test('12h. "!binary" usage message and "!binaryaccuracy" still work', async () => {
  resetWorld();
  const usage = await routeCommand('!binary', 'ef-chan');
  assert.match(usage, /^Usage: !binary EURUSD 5/);
  const acc = await routeCommand('!binaryaccuracy', 'ef-chan');
  assert.strictEqual(typeof acc, 'string');
  assert.ok(acc.length > 0 && !/^Could not load binary accuracy stats/.test(acc), acc);
  const { message, log } = makeMessage('!binaryaccuracy');
  await handleMessage(message);
  assert.deepStrictEqual(log.map((l) => l.op), ['reply']);
});

test('12i. unknown commands are ignored; "!market" with nothing usable gives guidance', async () => {
  resetWorld();
  assert.strictEqual(await routeCommand('!unknowncommand', 'ef-chan'), null);
  const { message, log } = makeMessage('!market');
  await handleMessage(message);
  assert.deepStrictEqual(log.map((l) => l.op), ['reply']);
  assert.match(log[0].content, /Symbol samajh nahi aaya/);
});

// ---------------------------------------------------------------- 12: pre-existing formatters + kept modules
test('12j. the pre-existing !market layouts still render (used for views, follow-ups and the degraded fallback)', async () => {
  resetWorld();
  const inputs = makeInputs({ duration: 30, count: 825 });
  const signal = await binaryEngine.generateBinarySignal(inputs.symbol, inputs.duration, inputs);
  const ai = await analyst.runIndependentAnalysis(inputs, { providerOverride: makeFakeProvider('ok') });
  const comparison = compareAnalyses(signal, ai);

  const full = formatting.formatMarketAnalysis(signal, ai, comparison, { expiryPerf: { total: 0, winRatePct: null, label: '30 min' } });
  ['**MARKET ANALYSIS**', '**BOT ANALYST**', '**AI ANALYST**', '**COMPARISON**', '**RESEARCH SUMMARY**', '**AI EXPLANATION**'].forEach((h) => assert.ok(full.includes(h), h));
  assert.match(formatting.formatMarketAnalysis(signal, ai, comparison, { compact: true }), /^\*\*EURUSD\*\* \(30min\)/);
  assert.match(formatting.formatDifferencesOnly(comparison), /^\*\*Comparison: /);
  assert.match(formatting.formatReasoningOnly(signal, ai), /^\*\*Reasoning\*\*/);
  assert.match(formatting.formatDataQualityOnly(signal), /^\*\*Data Quality - EURUSD\*\*/);
  assert.ok(formatting.botStatusLine(signal).length > 0);
  assert.ok(formatting.aiStatusLine(ai).length > 0);
});

test('12k. analysisMemory.js and analysisLog.js are NOT deleted (still loadable, API intact) - just no longer used by !market', () => {
  const mem = require('../src/services/analysisMemory');
  const log = require('../src/services/analysisLog');
  assert.deepStrictEqual(Object.keys(mem).sort(), ['getLastAnalysis', 'saveLastAnalysis']);
  assert.deepStrictEqual(Object.keys(log).sort(), ['getRecentAnalyses', 'logAnalysis']);
});

test('12l. no new runtime dependencies were added; npm test is wired to the suite', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(pkg.dependencies).sort(), ['@upstash/redis', 'axios', 'discord.js', 'dotenv', 'express', 'node-cron', 'technicalindicators']);
  assert.strictEqual(pkg.scripts.test, 'node tests/run-all.js');
  assert.strictEqual(pkg.scripts.start, 'node src/index.js');
});

test('12m. src/index.js does not auto-start when required (only when run directly)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf8');
  assert.match(src, /if \(require\.main === module\)/);
});

run('existing features');
