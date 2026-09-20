require('./helpers/stubDeps');
const assert = require('assert');
const { test, run } = require('./testKit');
const {
  makeCandles, makeInputs, deferred, sleep,
} = require('./helpers/fixtures');
const { makeFakeRedis } = require('./helpers/fakeRedis');
const { makeFakeProvider } = require('../src/services/ai/fakeProvider');
const store = require('../src/services/redisStore');
const config = require('../src/config');
const binaryEngine = require('../src/services/binaryEngine');
const analyst = require('../src/services/ai/analyst');
const { buildPrompt } = require('../src/services/ai/prompt');
const { runMarketWorkflow } = require('../src/services/marketWorkflow');
const { handleMarketCommand } = require('../src/commands/market');
const formatting = require('../src/utils/marketFormatting');

store.redis = makeFakeRedis();

const REQUEST = { symbol: 'EURUSD', horizonMinutes: 240, language: 'en' };

// Runs the workflow with a fake market-data fetch + fake AI provider; the
// bot branch is the REAL deterministic engine unless `deps.runBot` says
// otherwise.
function runWf({
  mode = 'report', provider, deps = {}, timeoutMs = 5000, inputs = makeInputs(), request = REQUEST,
} = {}) {
  return runMarketWorkflow(request, {
    mode,
    timeoutMs,
    deps: { fetchInputs: async () => inputs, ...deps },
    aiOptions: { providerOverride: provider },
  });
}

async function realBot(inputs) {
  const signal = await binaryEngine.generateBinarySignal(inputs.symbol, inputs.duration, inputs);
  return {
    status: 'OK', signal, expiryPerf: null, reason: null, latencyMs: 1,
  };
}

// A real bot result with distinctive values, so tests can prove exactly
// where the bot's verdict does (synthesis) and does not (independent AI) go.
async function sentinelBot(inputs) {
  const r = await realBot(inputs);
  Object.assign(r.signal, {
    direction: 'UP', rawDirection: 'UP', calibratedProbability: 73.7, rawProbability: 88.8, qualityLabel: 'HIGH', noTradeReasons: ['SENTINEL_NO_TRADE_REASON_XYZ'],
  });
  return r;
}

const FORBIDDEN_KEYS = [
  'direction', 'rawDirection', 'calibratedProbability', 'rawProbability', 'qualityLabel', 'noTradeReasons', 'tilt',
  'confluenceBreakdown', 'confluenceGroupScores', 'highTrust', 'checkpoints', 'regime', 'supportResistance', 'breakout',
  'divergences', 'multiTimeframe', 'featureFlags', 'structure', 'botAnalysis', 'comparison',
];

function collectKeys(value, out = new Set()) {
  if (Array.isArray(value)) value.forEach((v) => collectKeys(v, out));
  else if (value && typeof value === 'object') {
    Object.entries(value).forEach(([k, v]) => { out.add(k); collectKeys(v, out); });
  }
  return out;
}

async function withConfig(patch, fn) {
  const saved = { ...config.ai.gemini };
  Object.assign(config.ai.gemini, patch);
  try { return await fn(); } finally { Object.assign(config.ai.gemini, saved); }
}

// ---------------------------------------------------------------- 1
test('1. "!market EURUSD 4H" starts the workflow with the parsed symbol, horizon and default report mode', async () => {
  const calls = [];
  const fakeWorkflow = async (request, options) => {
    calls.push({ request, options });
    return {
      outcome: 'INSUFFICIENT_DATA', reasonCode: 'DATA_FETCH_FAILED', reason: 'x', request, totalMs: 1,
    };
  };
  const text = await handleMarketCommand('t1-chan', 'EURUSD 4H', {}, { runMarketWorkflow: fakeWorkflow });
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0].request, { symbol: 'EURUSD', horizonMinutes: 240, language: 'en' });
  assert.strictEqual(calls[0].options.mode, 'report');
  assert.ok(text.includes('INSUFFICIENT_DATA'));
});

test('1b. the workflow fetches market data ONCE and runs the bot, the independent AI and the synthesis', async () => {
  store.redis = makeFakeRedis();
  const provider = makeFakeProvider('ok');
  let fetches = 0;
  const inputs = makeInputs();
  const result = await runWf({ provider, deps: { fetchInputs: async () => { fetches += 1; return inputs; } } });
  assert.strictEqual(fetches, 1, 'one shared fetch, not one per branch');
  assert.strictEqual(result.outcome, 'REPORT');
  assert.strictEqual(result.bot.status, 'OK');
  assert.ok(['UP', 'DOWN', 'NO_TRADE'].includes(result.bot.signal.direction));
  assert.strictEqual(result.ai.status, 'OK');
  assert.strictEqual(result.synthesis.status, 'OK');
  assert.deepStrictEqual(provider.calls.map((c) => c.kind), ['independent', 'synthesis']);
});

// ---------------------------------------------------------------- 2
test('2. bot and AI start independently: the AI starts while the bot is still running (neither waits for the other)', async () => {
  store.redis = makeFakeRedis();
  const inputs = makeInputs();
  const botResult = await realBot(inputs);
  const events = [];
  const botGate = deferred();
  // The bot cannot finish until the test releases it - and the test only
  // releases it once the AI provider has been CALLED. If the workflow ran
  // the AI after the bot, this would deadlock and hit the deadline.
  const provider = makeFakeProvider('ok', {
    onCall: (r) => {
      events.push(`ai:${r.kind}:start`);
      if (r.kind === 'independent') setTimeout(() => botGate.resolve(), 15);
    },
  });
  const deps = {
    runBot: async () => { events.push('bot:start'); await botGate.promise; events.push('bot:end'); return botResult; },
  };
  const result = await runWf({
    provider, deps, inputs, timeoutMs: 3000,
  });
  assert.notStrictEqual(result.outcome, 'TIMEOUT', 'AI must not be waiting for the bot');
  assert.strictEqual(result.outcome, 'REPORT');
  assert.ok(events.includes('bot:start') && events.includes('ai:independent:start'));
  assert.ok(events.indexOf('ai:independent:start') < events.indexOf('bot:end'), `events: ${events.join(', ')}`);
  assert.ok(events.indexOf('bot:start') < events.indexOf('bot:end'));
  assert.ok(events.indexOf('ai:synthesis:start') > events.indexOf('bot:end'), 'synthesis only after both analyses finished');
});

test('2b. ...and the bot does not wait for the AI either', async () => {
  store.redis = makeFakeRedis();
  const inputs = makeInputs();
  const botResult = await realBot(inputs);
  const provider = makeFakeProvider('ok', { delayMsByKind: { independent: 120 } });
  let botEnded = null;
  const deps = { runBot: async () => { botEnded = Date.now(); return botResult; } };
  const result = await runWf({ provider, deps, inputs });
  const aiCall = provider.calls.find((c) => c.kind === 'independent');
  assert.strictEqual(result.outcome, 'REPORT');
  assert.ok(aiCall.startedAt <= botEnded + 40, 'AI started right away, not after the bot');
  assert.ok(botEnded <= aiCall.endedAt - 80, 'bot finished long before the slow AI did');
});

// ---------------------------------------------------------------- 3
test('3. the independent AI stage cannot see the bot conclusion (architecture + actual context + prompt)', async () => {
  store.redis = makeFakeRedis();
  const provider = makeFakeProvider('ok');
  const seen = [];
  const deps = {
    runBot: sentinelBot,
    runIndependentAI: (inputs, opts) => { seen.push({ inputs, opts }); return analyst.runIndependentAnalysis(inputs, opts); },
  };
  const result = await runWf({ provider, deps });
  assert.strictEqual(result.outcome, 'REPORT');

  // Architecture: the AI branch is invoked with raw inputs + options only.
  assert.strictEqual(seen.length, 1);
  assert.deepStrictEqual(
    Object.keys(seen[0].inputs).sort(),
    ['candles', 'duration', 'entryPrice', 'fetchSize', 'fetchedAt', 'priceSource', 'staleness', 'statsLookback', 'symbol'],
  );
  assert.deepStrictEqual(Object.keys(seen[0].opts).sort(), ['language', 'providerOverride', 'signal']);

  // What the model was actually shown.
  const ctx = provider.calls.find((c) => c.kind === 'independent').context;
  assert.deepStrictEqual(Object.keys(ctx), ['request', 'referencePrice', 'dataQuality', 'candles']);
  const json = JSON.stringify(ctx);
  ['73.7', '88.8', 'SENTINEL_NO_TRADE_REASON_XYZ'].forEach((needle) => assert.ok(!json.includes(needle), `leaked ${needle}`));
  const keys = collectKeys(ctx);
  FORBIDDEN_KEYS.forEach((k) => assert.ok(!keys.has(k), `independent context contains bot-derived key "${k}"`));

  // And the prompt text built from it.
  const prompt = buildPrompt(ctx, 'en');
  assert.ok(!/NO_TRADE|botAnalysis|calibrat|confluence/i.test(prompt));
});

test('3b. the independent AI is shown raw multi-resolution candles and data-freshness facts', async () => {
  const provider = makeFakeProvider('ok');
  await runWf({ provider });
  const ctx = provider.calls[0].context;
  assert.deepStrictEqual(Object.keys(ctx.candles), ['1m', '5m', '15m']);
  assert.deepStrictEqual(ctx.candles['1m'].columns, ['t', 'o', 'h', 'l', 'c']); // FX: no volume column
  assert.strictEqual(ctx.candles['1m'].rows.length, 60);
  assert.strictEqual(ctx.request.horizonMinutes, 240);
  assert.strictEqual(ctx.dataQuality.stale, false);
  assert.strictEqual(ctx.dataQuality.volumeAvailable, false);
});

// ---------------------------------------------------------------- 4
test('4. the final synthesis receives the bot analysis, the AI analysis, market context, comparison and limitations', async () => {
  store.redis = makeFakeRedis();
  const provider = makeFakeProvider('ok', { conclusion: 'DOWN', confidence: 'HIGH' });
  const result = await runWf({ provider, deps: { runBot: sentinelBot } });
  const synthCall = provider.calls.find((c) => c.kind === 'synthesis');
  const aiCall = provider.calls.find((c) => c.kind === 'independent');
  const ctx = synthCall.context;

  assert.strictEqual(ctx.botAnalysis.status, 'OK');
  assert.strictEqual(ctx.botAnalysis.direction, 'UP');
  assert.strictEqual(ctx.botAnalysis.calibratedProbabilityPct, 73.7);
  assert.deepStrictEqual(ctx.botAnalysis.noTradeReasons, ['SENTINEL_NO_TRADE_REASON_XYZ']);
  assert.strictEqual(ctx.independentAiAnalysis.status, 'OK');
  assert.strictEqual(ctx.independentAiAnalysis.analysis.conclusion, 'DOWN');
  assert.strictEqual(ctx.comparison.relationship, 'DISAGREEMENT'); // bot UP vs AI DOWN
  assert.ok(Array.isArray(ctx.dataQualityLimitations) && ctx.dataQualityLimitations.length > 0);
  assert.strictEqual(typeof ctx.marketContext.referencePrice, 'number');
  assert.ok(ctx.marketContext.window.candles > 0);
  assert.strictEqual(ctx.request.symbol, 'EURUSD');
  assert.ok(synthCall.startedAt >= aiCall.endedAt, 'synthesis starts after the independent AI finished');

  // Deterministic guardrail: a disagreement can never be reported as confident.
  assert.strictEqual(result.synthesis.synthesis.confidence, 'LOW');
  assert.match(result.synthesis.synthesis.confidenceNote, /disagree/);
});

// ---------------------------------------------------------------- 6
test('6. no Redis WRITE happens in the workflow - only the bot\'s calibration READs', async () => {
  const redis = makeFakeRedis();
  store.redis = redis;
  const result = await runWf({ provider: makeFakeProvider('ok') });
  assert.strictEqual(result.outcome, 'REPORT');
  assert.deepStrictEqual(redis.writeCalls(), []);
  assert.ok(redis.readCalls().length > 0, 'calibration reads still happen');
});

test('6b. the whole command path (including follow-up memory) writes nothing to Redis', async () => {
  const redis = makeFakeRedis();
  store.redis = redis;
  const provider = makeFakeProvider('ok');
  const opts = { workflowOptions: { deps: { fetchInputs: async () => makeInputs({ duration: 5, count: 120 }) }, aiOptions: { providerOverride: provider } } };
  const first = await handleMarketCommand('t6b-chan', 'EURUSD 5m', {}, opts);
  assert.match(first, /MARKET RESEARCH REPORT/);
  const followUp = await handleMarketCommand('t6b-chan', 'sirf differences batao', {}, opts);
  assert.match(followUp, /Comparison:/);
  assert.deepStrictEqual(redis.writeCalls(), []);
});

test('6c. the !market path does not load the Redis-backed analysisMemory / analysisLog modules at all', () => {
  require('../src/index');
  require('../src/commands/market');
  require('../src/services/marketWorkflow');
  const loaded = Object.keys(require.cache).filter((k) => /analysisMemory|analysisLog/.test(k));
  assert.deepStrictEqual(loaded, []);
});

test('6d. AI_MEMORY_TTL_MIN is not a dependency: the flow works with it unset and the config value absent', async () => {
  store.redis = makeFakeRedis();
  const saved = config.ai.memoryTtlMinutes;
  const savedEnv = process.env.AI_MEMORY_TTL_MIN;
  delete process.env.AI_MEMORY_TTL_MIN;
  delete config.ai.memoryTtlMinutes;
  try {
    const provider = makeFakeProvider('ok');
    const text = await handleMarketCommand('t6d-chan', 'EURUSD 5m', {}, {
      workflowOptions: { deps: { fetchInputs: async () => makeInputs({ duration: 5, count: 120 }) }, aiOptions: { providerOverride: provider } },
    });
    assert.match(text, /MARKET RESEARCH REPORT/);
  } finally {
    config.ai.memoryTtlMinutes = saved;
    if (savedEnv !== undefined) process.env.AI_MEMORY_TTL_MIN = savedEnv;
  }
});

// ---------------------------------------------------------------- 7
test('7. bot failure: the AI branch is NOT cancelled, the synthesis reports the limitation, confidence is capped', async () => {
  store.redis = makeFakeRedis();
  const provider = makeFakeProvider('ok', { synthesis: { overallView: 'UP', confidence: 'HIGH' } });
  const deps = { runBot: async () => ({ status: 'ERROR', signal: null, expiryPerf: null, reason: 'engine exploded', latencyMs: 1 }) };
  const result = await runWf({ provider, deps });

  const indep = provider.calls.find((c) => c.kind === 'independent');
  assert.ok(indep && indep.endedAt, 'the independent AI call ran to completion');
  assert.strictEqual(indep.signalAborted(), false);
  assert.strictEqual(result.ai.status, 'OK');
  assert.strictEqual(result.outcome, 'REPORT');

  const ctx = provider.calls.find((c) => c.kind === 'synthesis').context;
  assert.strictEqual(ctx.botAnalysis.status, 'ERROR');
  assert.match(ctx.botAnalysis.reason, /engine exploded/);
  assert.ok(ctx.dataQualityLimitations.some((l) => /Bot analysis unavailable: engine exploded/.test(l)));
  assert.strictEqual(result.comparison.relationship, 'INSUFFICIENT_DATA');
  assert.strictEqual(result.synthesis.synthesis.confidence, 'MEDIUM', 'HIGH must be capped when only one analysis exists');

  const text = formatting.renderWorkflowResult(result);
  assert.match(text, /Bot engine: unavailable \(engine exploded\)/);
});

test('7b. a bot branch that THROWS (rather than returning an error) is contained the same way', async () => {
  store.redis = makeFakeRedis();
  const provider = makeFakeProvider('ok');
  const result = await runWf({ provider, deps: { runBot: async () => { throw new Error('kaboom'); } } });
  assert.strictEqual(result.bot.status, 'ERROR');
  assert.match(result.bot.reason, /kaboom/);
  assert.strictEqual(result.ai.status, 'OK');
  assert.strictEqual(result.outcome, 'REPORT');
});

test('7c. real engine failure (Redis down during calibration) also leaves the AI branch intact', async () => {
  store.redis = { get: async () => { throw new Error('redis unreachable'); } };
  const provider = makeFakeProvider('ok');
  const result = await runWf({ provider });
  assert.strictEqual(result.bot.status, 'ERROR');
  assert.match(result.bot.reason, /redis unreachable/);
  assert.strictEqual(result.ai.status, 'OK');
  assert.strictEqual(result.outcome, 'REPORT');
  store.redis = makeFakeRedis();
});

// ---------------------------------------------------------------- 8
[
  ['timeout', 'timeout', 'TIMEOUT'],
  ['rate limit', 'rate-limit', 'RATE_LIMITED'],
  ['malformed JSON', 'malformed', 'ERROR'],
  ['schema-invalid JSON', 'schema-invalid', 'ERROR'],
  ['blocked/empty response', 'empty', 'UNAVAILABLE'],
].forEach(([label, behavior, status]) => {
  test(`8. AI failure (${label}): bot analysis is kept, AI shown as unavailable, no synthesis call`, async () => {
    store.redis = makeFakeRedis();
    const provider = makeFakeProvider({ independent: behavior, synthesis: 'ok' });
    const result = await runWf({ provider });
    assert.strictEqual(result.ai.status, status);
    assert.strictEqual(result.bot.status, 'OK');
    assert.ok(result.bot.signal.direction, 'bot result is not discarded');
    assert.strictEqual(result.outcome, 'DEGRADED');
    assert.strictEqual(result.reasonCode, 'AI_UNAVAILABLE');
    assert.strictEqual(provider.calls.filter((c) => c.kind === 'synthesis').length, 0);

    const text = formatting.renderWorkflowResult(result);
    assert.match(text, /BOT ANALYST/);
    assert.ok(text.includes(formatting.botStatusLine(result.bot.signal)), 'bot verdict is shown');
    assert.match(text, /Independent conclusion: unavailable/);
    assert.ok(text.includes(`Reason: ${status} - `), 'AI error state is explicit, with its status');
    assert.match(text, /Final AI synthesis not available/);
  });
});

test('8b. AI not configured: explicit reason for a missing key, and for a missing GEMINI_MODEL (no hard-coded fallback model)', async () => {
  store.redis = makeFakeRedis();
  await withConfig({ apiKey: '', model: '' }, async () => {
    const r = await runWf({ provider: undefined });
    assert.strictEqual(r.ai.status, 'UNAVAILABLE');
    assert.match(r.ai.reason, /GEMINI_API_KEY is not set/);
    assert.strictEqual(r.bot.status, 'OK');
    assert.strictEqual(r.outcome, 'DEGRADED');
  });
  await withConfig({ apiKey: 'some-key', model: '' }, async () => {
    const r = await runWf({ provider: undefined });
    assert.strictEqual(r.ai.status, 'UNAVAILABLE');
    assert.match(r.ai.reason, /GEMINI_MODEL is not set/);
    assert.strictEqual(r.bot.status, 'OK');
  });
});

// ---------------------------------------------------------------- 9
test('9. data fetch failure -> INSUFFICIENT_DATA: no AI call, no bot call, no fabricated numbers', async () => {
  const provider = makeFakeProvider('ok');
  let botCalled = false;
  const deps = {
    fetchInputs: async () => { throw new Error('Twelve Data error for EURUSD: no values returned'); },
    runBot: async () => { botCalled = true; return realBot(makeInputs()); },
  };
  const result = await runWf({ provider, deps });
  assert.strictEqual(result.outcome, 'INSUFFICIENT_DATA');
  assert.strictEqual(result.reasonCode, 'DATA_FETCH_FAILED');
  assert.strictEqual(provider.calls.length, 0, 'no Gemini call without data');
  assert.strictEqual(botCalled, false);
  assert.strictEqual(result.bot, null);
  assert.strictEqual(result.ai, null);
  assert.strictEqual(result.comparison, null);

  const text = formatting.renderWorkflowResult(result);
  assert.match(text, /INSUFFICIENT_DATA/);
  assert.ok(!/\d+(\.\d+)?%/.test(text), 'no probability/percentage anywhere');
  assert.ok(!/\b(UP|DOWN)\b/.test(text), 'no direction anywhere');
});

test('9b. too few candles from the provider (real fetch path) -> INSUFFICIENT_DATA / TOO_FEW_CANDLES', async () => {
  const td = require('../src/services/twelvedata');
  const saved = { ts: td.getTimeSeries, cp: td.getCurrentPrice };
  td.getTimeSeries = async () => makeCandles({ count: 10 });
  td.getCurrentPrice = async () => 1.08;
  try {
    const provider = makeFakeProvider('ok');
    // no fetchInputs override -> the workflow's default real fetchSignalInputs
    const result = await runMarketWorkflow(REQUEST, { timeoutMs: 3000, aiOptions: { providerOverride: provider } });
    assert.strictEqual(result.outcome, 'INSUFFICIENT_DATA');
    assert.strictEqual(result.reasonCode, 'TOO_FEW_CANDLES');
    assert.match(result.reason, /got 10 candles/);
    assert.strictEqual(provider.calls.length, 0);
  } finally {
    td.getTimeSeries = saved.ts;
    td.getCurrentPrice = saved.cp;
  }
});

test('9c. corrupt candles (fail validation) -> INSUFFICIENT_DATA / INVALID_DATA, no AI call', async () => {
  const inputs = makeInputs();
  inputs.candles.forEach((c, i) => { if (i % 2 === 0) c.high = c.low - 1; }); // half the bars have high < low
  const provider = makeFakeProvider('ok');
  const result = await runWf({ provider, inputs });
  assert.strictEqual(result.outcome, 'INSUFFICIENT_DATA');
  assert.strictEqual(result.reasonCode, 'INVALID_DATA');
  assert.strictEqual(provider.calls.length, 0);
});

// ---------------------------------------------------------------- 10
test('10. timeout while the AI hangs: bot analysis kept, in-flight AI call is CANCELLED, returns promptly', async () => {
  store.redis = makeFakeRedis();
  const provider = makeFakeProvider({ independent: 'hang', synthesis: 'ok' });
  const t0 = Date.now();
  const result = await runWf({ provider, timeoutMs: 250 });
  assert.ok(Date.now() - t0 < 2000, 'must not wait on the hung AI call');
  assert.strictEqual(result.outcome, 'DEGRADED');
  assert.strictEqual(result.reasonCode, 'WORKFLOW_TIMEOUT');
  assert.strictEqual(result.ai.status, 'TIMEOUT');
  assert.strictEqual(result.bot.status, 'OK');
  assert.strictEqual(provider.calls[0].signalAborted(), true, 'the abort signal reached the provider');
  assert.strictEqual(provider.calls.filter((c) => c.kind === 'synthesis').length, 0);
});

test('10b. timeout with nothing finished -> concise TIMEOUT state', async () => {
  const provider = makeFakeProvider({ independent: 'hang' });
  const deps = { runBot: () => new Promise(() => {}) };
  const result = await runWf({ provider, deps, timeoutMs: 200 });
  assert.strictEqual(result.outcome, 'TIMEOUT');
  const text = formatting.renderWorkflowResult(result);
  assert.match(text, /TIMEOUT/);
  assert.ok(text.length < 400, `concise, got ${text.length} chars`);
});

test('10c. timeout during the final synthesis: both analyses are still delivered', async () => {
  store.redis = makeFakeRedis();
  const provider = makeFakeProvider({ independent: 'ok', synthesis: 'hang' });
  const result = await runWf({ provider, timeoutMs: 400 });
  assert.strictEqual(result.outcome, 'DEGRADED');
  assert.strictEqual(result.reasonCode, 'WORKFLOW_TIMEOUT');
  assert.strictEqual(result.bot.status, 'OK');
  assert.strictEqual(result.ai.status, 'OK');
  assert.strictEqual(provider.calls.find((c) => c.kind === 'synthesis').signalAborted(), true);
  const text = formatting.renderWorkflowResult(result);
  assert.match(text, /BOT ANALYST/);
  assert.match(text, /AI ANALYST/);
});

test('10d. market-data fetch that never returns -> TIMEOUT (DATA_TIMEOUT), no AI call', async () => {
  const provider = makeFakeProvider('ok');
  const result = await runWf({ provider, deps: { fetchInputs: () => new Promise(() => {}) }, timeoutMs: 150 });
  assert.strictEqual(result.outcome, 'TIMEOUT');
  assert.strictEqual(result.reasonCode, 'DATA_TIMEOUT');
  assert.strictEqual(provider.calls.length, 0);
});

// ---------------------------------------------------------------- 11
test('11. final report: header, research view, both analyses, limitations, summary, disclaimer; deterministic numbers', async () => {
  store.redis = makeFakeRedis();
  const result = await runWf({ provider: makeFakeProvider('ok') });
  assert.strictEqual(result.outcome, 'REPORT');
  const text = formatting.renderWorkflowResult(result);
  assert.match(text, /\*\*MARKET RESEARCH REPORT\*\* - EURUSD \| horizon 4 h \(240 min\)/);
  assert.match(text, /Data: ref price .* \| last candle .* \| data quality: /);
  assert.match(text, /\*\*Research view: (UP|DOWN|NO_VIEW)\*\* \(confidence (LOW|MEDIUM|HIGH)\)/);
  assert.match(text, /How the two analyses compare/);
  assert.ok(text.includes(`Bot engine: ${formatting.botStatusLine(result.bot.signal)}`), 'bot numbers printed by code');
  assert.match(text, /Independent AI: UP \(MEDIUM confidence\)/);
  assert.match(text, /What would change the view/);
  assert.match(text, /Research summary/);
  assert.match(text, /not financial advice/);
  formatting.splitForDiscord(text).forEach((chunk) => assert.ok(chunk.length <= 2000));
});

test('11b. compact report is shorter and still carries the research view', async () => {
  store.redis = makeFakeRedis();
  const result = await runWf({ provider: makeFakeProvider('ok') });
  const full = formatting.renderWorkflowResult(result);
  const compact = formatting.renderWorkflowResult(result, { compact: true });
  assert.ok(compact.length < full.length / 2);
  assert.match(compact, /Research view: \*\*(UP|DOWN|NO_VIEW)\*\*/);
});

test('11c. oversized LLM lists are bounded for display and always fit Discord-sized chunks', async () => {
  store.redis = makeFakeRedis();
  const result = await runWf({ provider: makeFakeProvider('ok') });
  const long = Array.from({ length: 8 }, (_, i) => `${i} ${'x'.repeat(290)}`);
  result.synthesis.synthesis.whereTheyAgree = long;
  result.synthesis.synthesis.whereTheyDisagree = long;
  result.synthesis.synthesis.contradictions = long;
  result.synthesis.synthesis.dataQualityLimitations = long;
  result.synthesis.synthesis.whatWouldChangeTheView = long;
  const text = formatting.renderWorkflowResult(result);
  const chunks = formatting.splitForDiscord(text);
  chunks.forEach((c) => assert.ok(c.length <= 2000));
  assert.ok(chunks.length <= 4, `expected a bounded number of messages, got ${chunks.length}`);
  assert.match(text, /\(\+4 more\)/);
});

['malformed', 'schema-invalid', 'error', 'timeout', 'empty'].forEach((behavior) => {
  test(`11d. synthesis "${behavior}": degrades to the two analyses, nothing dropped, reason stated`, async () => {
    store.redis = makeFakeRedis();
    const provider = makeFakeProvider({ independent: 'ok', synthesis: behavior });
    const result = await runWf({ provider });
    assert.strictEqual(result.outcome, 'DEGRADED');
    assert.strictEqual(result.reasonCode, 'SYNTHESIS_FAILED');
    const text = formatting.renderWorkflowResult(result);
    assert.match(text, /Final AI synthesis not available/);
    assert.match(text, /BOT ANALYST/);
    assert.match(text, /AI ANALYST/);
    assert.match(text, /Independent conclusion: UP/);
  });
});

// ---------------------------------------------------------------- modes
test('modes: comparison view skips the synthesis call; data-quality view makes no AI call at all', async () => {
  store.redis = makeFakeRedis();
  const p1 = makeFakeProvider('ok');
  const cmp = await runWf({ provider: p1, mode: 'comparison' });
  assert.strictEqual(cmp.outcome, 'ANALYSES');
  assert.deepStrictEqual(p1.calls.map((c) => c.kind), ['independent']);
  assert.match(formatting.renderWorkflowResult(cmp, { intent: 'differences-only' }), /Comparison:/);

  const p2 = makeFakeProvider('ok');
  const dq = await runWf({ provider: p2, mode: 'dataquality' });
  assert.strictEqual(dq.outcome, 'ANALYSES');
  assert.strictEqual(p2.calls.length, 0);
  assert.strictEqual(dq.ai, null);
  assert.match(formatting.renderWorkflowResult(dq, { intent: 'dataquality' }), /Data Quality - EURUSD/);
});

test('isolation: two concurrent runs keep their own state', async () => {
  store.redis = makeFakeRedis();
  const pA = makeFakeProvider('ok', { delayMs: 30 });
  const pB = makeFakeProvider('ok', { delayMs: 5 });
  const [a, b] = await Promise.all([
    runWf({ provider: pA, inputs: makeInputs({ symbol: 'EURUSD', seed: 1 }), request: { ...REQUEST, symbol: 'EURUSD' } }),
    runWf({ provider: pB, inputs: makeInputs({ symbol: 'BTCUSD', start: 65000, withVolume: true, seed: 2 }), request: { ...REQUEST, symbol: 'BTCUSD' } }),
  ]);
  assert.strictEqual(a.market.symbol, 'EURUSD');
  assert.strictEqual(b.market.symbol, 'BTCUSD');
  assert.strictEqual(pA.calls[0].context.request.symbol, 'EURUSD');
  assert.strictEqual(pB.calls[0].context.request.symbol, 'BTCUSD');
  assert.deepStrictEqual(pB.calls[0].context.candles['1m'].columns, ['t', 'o', 'h', 'l', 'c', 'v']); // crypto: volume present
});

test('the workflow never throws, even if every dependency explodes', async () => {
  const boom = async () => { throw new Error('boom'); };
  const result = await runMarketWorkflow(REQUEST, {
    timeoutMs: 1000,
    deps: { fetchInputs: boom },
  });
  assert.strictEqual(result.outcome, 'INSUFFICIENT_DATA');
  const r2 = await runWf({
    provider: makeFakeProvider('ok'),
    deps: { runBot: boom, runIndependentAI: boom, runSynthesis: boom },
  });
  assert.strictEqual(r2.outcome, 'ERROR');
  assert.strictEqual(r2.reasonCode, 'BOTH_FAILED');
  await sleep(5);
});

run('market workflow');
