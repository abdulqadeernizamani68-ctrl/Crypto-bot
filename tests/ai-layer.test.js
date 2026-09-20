require('./helpers/stubDeps');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { test, run } = require('./testKit');
const { makeInputs, makeCandles, sleep } = require('./helpers/fixtures');
const { makeFakeRedis } = require('./helpers/fakeRedis');
const { makeFakeProvider, makeGoodResponse, makeGoodSynthesis } = require('../src/services/ai/fakeProvider');
const store = require('../src/services/redisStore');
const config = require('../src/config');
const binaryEngine = require('../src/services/binaryEngine');
const provider = require('../src/services/ai/provider');
const geminiProvider = require('../src/services/ai/geminiProvider');
const analyst = require('../src/services/ai/analyst');
const schema = require('../src/services/ai/schema');
const { buildPrompt, buildSynthesisPrompt } = require('../src/services/ai/prompt');
const ctxSvc = require('../src/services/ai/marketContext');
const { compareAnalyses } = require('../src/services/ai/comparison');

store.redis = makeFakeRedis();
const ROOT = path.resolve(__dirname, '..');

async function withGemini(patch, fn) {
  const saved = { ...config.ai.gemini };
  Object.assign(config.ai.gemini, patch);
  try { return await fn(); } finally { Object.assign(config.ai.gemini, saved); }
}

async function realSignal(overrides = {}) {
  const inputs = makeInputs();
  const signal = await binaryEngine.generateBinarySignal(inputs.symbol, inputs.duration, inputs);
  return { inputs, signal: Object.assign(signal, overrides) };
}

const okAi = (extra = {}) => ({
  status: 'OK', reason: null, latencyMs: 1, usage: null, analysis: JSON.parse(makeGoodResponse(extra)),
});

// ================================================================ model / env config
test('config: no Gemini model id is hard-coded anywhere in src/', () => {
  const offenders = [];
  (function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js') && /['"`]gemini-\d/.test(fs.readFileSync(p, 'utf8'))) offenders.push(path.relative(ROOT, p));
    });
  }(path.join(ROOT, 'src')));
  assert.deepStrictEqual(offenders, []);
});

function loadConfigInFreshProcess(env) {
  const script = `console.log(JSON.stringify(require(${JSON.stringify(path.join(ROOT, 'src', 'config.js'))})))`;
  const res = spawnSync(process.execPath, ['-r', path.join(ROOT, 'tests', 'helpers', 'stubDeps.js'), '-e', script], {
    cwd: os.tmpdir(), // no .env file to pick up
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
  });
  assert.strictEqual(res.status, 0, res.stderr);
  return JSON.parse(res.stdout.trim().split('\n').pop());
}

test('config: GEMINI_MODEL comes ONLY from the environment (empty when unset)', () => {
  assert.strictEqual(loadConfigInFreshProcess({}).ai.gemini.model, '');
  assert.strictEqual(loadConfigInFreshProcess({ GEMINI_MODEL: '  some-future-model  ' }).ai.gemini.model, 'some-future-model');
});

test('config: existing environment variables keep their names and meaning; new ones are optional', () => {
  const cfg = loadConfigInFreshProcess({
    DISCORD_BOT_TOKEN: 'd-tok', TWELVEDATA_API_KEY: 'td-key', UPSTASH_REDIS_REST_URL: 'https://r.example', UPSTASH_REDIS_REST_TOKEN: 'r-tok', PORT: '4321', AI_PROVIDER: 'Gemini', GEMINI_API_KEY: 'g-key',
  });
  assert.strictEqual(cfg.discord.token, 'd-tok');
  assert.strictEqual(cfg.twelvedata.apiKey, 'td-key');
  assert.strictEqual(cfg.redis.url, 'https://r.example');
  assert.strictEqual(cfg.redis.token, 'r-tok');
  assert.strictEqual(cfg.server.port, 4321);
  assert.strictEqual(cfg.ai.provider, 'gemini');
  assert.strictEqual(cfg.ai.gemini.apiKey, 'g-key');
  // defaults of the new optional knobs
  assert.strictEqual(cfg.market.workflowTimeoutMs, 120000);
  assert.strictEqual(cfg.ai.gemini.timeoutMs, 60000);
  assert.strictEqual(cfg.ai.gemini.maxOutputTokens, 4096);
  assert.strictEqual(loadConfigInFreshProcess({ MARKET_WORKFLOW_TIMEOUT_MS: '90000' }).market.workflowTimeoutMs, 90000);
});

test('provider.getConfigProblem names exactly what is missing', () => {
  [
    [{ apiKey: '', model: '' }, /GEMINI_API_KEY is not set/],
    [{ apiKey: 'k', model: '' }, /GEMINI_MODEL is not set/],
    [{ apiKey: 'k', model: 'm' }, null],
  ].forEach(([patch, expected]) => {
    const saved = { ...config.ai.gemini };
    Object.assign(config.ai.gemini, patch);
    try {
      const problem = provider.getConfigProblem();
      if (expected) assert.match(problem, expected); else assert.strictEqual(problem, null);
      assert.strictEqual(provider.isConfigured(), expected === null);
    } finally { Object.assign(config.ai.gemini, saved); }
  });
  assert.match(provider.getConfigProblem('nonexistent'), /unknown AI provider/);
});

// ================================================================ schema
test('schema.validateSynthesis accepts a good synthesis and returns a whitelisted copy', () => {
  const raw = { ...JSON.parse(makeGoodSynthesis()), sneaky: 'dropped' };
  const v = schema.validateSynthesis(raw);
  assert.strictEqual(v.ok, true);
  assert.ok(!('sneaky' in v.value));
  assert.strictEqual(v.value.overallView, 'UP');
});

test('schema.validateSynthesis rejects bad enums, missing/oversized fields and executable-looking keys', () => {
  const good = JSON.parse(makeGoodSynthesis());
  const bad = [
    { ...good, overallView: 'MAYBE' },
    { ...good, confidence: 'SUPER' },
    { ...good, headline: '' },
    { ...good, headline: 'x'.repeat(301) },
    { ...good, report: 'x'.repeat(1501) },
    { ...good, whereTheyAgree: 'not a list' },
    { ...good, contradictions: Array(9).fill('x') },
    { ...good, dataQualityLimitations: ['x'.repeat(301)] },
    { ...good, function_call: { name: 'rm -rf' } },
    { ...good, code: 'process.exit(1)' },
    null,
    [],
    'string',
  ];
  bad.forEach((b, i) => assert.strictEqual(schema.validateSynthesis(b).ok, false, `case ${i} should be rejected`));
});

test('schema.validateAIAnalysis (stage 1) is unchanged and still strict', () => {
  assert.strictEqual(schema.validateAIAnalysis(JSON.parse(makeGoodResponse())).ok, true);
  assert.strictEqual(schema.validateAIAnalysis({ conclusion: 'MAYBE' }).ok, false);
});

// ================================================================ prompts
test('prompts: stage 1 asks for an independent view of RAW data; stage 2 is told about both analyses', () => {
  const p1 = buildPrompt({ request: { horizonMinutes: 240 }, candles: {} }, 'en');
  assert.match(p1, /RAW market data/);
  assert.match(p1, /next 240 minute/);
  assert.match(p1, /"conclusion": "UP" \| "DOWN" \| "NO_VIEW"/);
  assert.ok(!/botAnalysis/.test(p1));

  const p2 = buildSynthesisPrompt({ botAnalysis: { status: 'OK' }, independentAiAnalysis: { status: 'OK' } }, 'en');
  assert.match(p2, /botAnalysis/);
  assert.match(p2, /independentAiAnalysis/);
  assert.match(p2, /Do NOT give entry, stop-loss/);
  assert.match(p2, /"overallView": "UP" \| "DOWN" \| "NO_VIEW"/);
});

test('prompts: language instruction is honoured and enums stay English', () => {
  assert.match(buildPrompt({}, 'roman-urdu'), /Roman Urdu/);
  assert.match(buildSynthesisPrompt({}, 'roman-urdu'), /Roman Urdu/);
  assert.match(buildSynthesisPrompt({}, 'urdu'), /Urdu script/);
  assert.match(buildSynthesisPrompt({}, 'en'), /plain English/);
  assert.match(buildSynthesisPrompt({}, 'roman-urdu'), /Enum fields \(overallView, confidence\) stay in English/);
});

// ================================================================ marketContext
test('independent context: exact resampling (time-bucketed), partial oldest bar dropped', () => {
  const bucket = 15 * 60000;
  const base = Math.floor(Date.now() / bucket) * bucket - 10 * bucket;
  // start 5 minutes into a bucket -> first (partial) 15m bar must be dropped
  const candles = [];
  for (let i = 0; i < 40; i++) {
    candles.push({
      time: base + 5 * 60000 + i * 60000, open: 100 + i, high: 200 + i, low: 50 + i, close: 100.5 + i, volume: 10,
    });
  }
  const bars = ctxSvc.resample(candles, 15);
  assert.strictEqual(bars[0].time % bucket, 0);
  assert.strictEqual(bars[0].firstTime, bars[0].time, 'first kept bar starts on its bucket boundary');
  const second = bars[1];
  // second kept bar covers 15 full candles
  assert.strictEqual(second.n, 15);
  const startIdx = candles.findIndex((c) => c.time === second.time);
  assert.strictEqual(second.open, candles[startIdx].open);
  assert.strictEqual(second.close, candles[startIdx + 14].close);
  assert.strictEqual(second.high, candles[startIdx + 14].high);
  assert.strictEqual(second.low, candles[startIdx].low);
  assert.strictEqual(second.volume, 150);
});

test('independent context: volume column only when the provider supplied volume; stale flag from the snapshot', () => {
  const fx = ctxSvc.buildIndependentContext(makeInputs());
  assert.deepStrictEqual(fx.candles['1m'].columns, ['t', 'o', 'h', 'l', 'c']);
  assert.strictEqual(fx.dataQuality.volumeAvailable, false);
  const crypto = ctxSvc.buildIndependentContext(makeInputs({ withVolume: true }));
  assert.deepStrictEqual(crypto.candles['1m'].columns, ['t', 'o', 'h', 'l', 'c', 'v']);
  assert.strictEqual(crypto.dataQuality.volumeAvailable, true);

  const stale = ctxSvc.buildIndependentContext(makeInputs({ endTime: Date.now() - 3 * 24 * 3600 * 1000 }));
  assert.strictEqual(stale.dataQuality.stale, true);
  assert.ok(stale.dataQuality.lastCandleAgeMinutes > 4000);
  assert.strictEqual(fx.candles['1m'].rows.length, 60);
  assert.ok(fx.candles['5m'].rows.length <= 48 && fx.candles['15m'].rows.length <= 56);
});

test('independent context: data-quality issues in the raw candles are passed on, corrupt bars are dropped', () => {
  const inputs = makeInputs({ count: 200 });
  inputs.candles[50].high = inputs.candles[50].low - 1; // corrupt
  const ctx = ctxSvc.buildIndependentContext(inputs);
  assert.strictEqual(ctx.dataQuality.sourceCandleCount, 199);
  assert.ok(ctx.dataQuality.issues.some((i) => /invalid/.test(i)));
});

test('market facts are computed in code (not by the LLM): window range and % changes', () => {
  const now = Date.now();
  const candles = [];
  for (let i = 0; i < 300; i++) {
    const t = now - 60000 - (299 - i) * 60000;
    const price = i >= 240 ? 110 : 100; // last 60 candles at 110, older at 100
    candles.push({ time: t, open: price, high: price + 1, low: price - 1, close: price, volume: null });
  }
  const inputs = { ...makeInputs({ count: 30 }), candles, entryPrice: 110 };
  const m = ctxSvc.summarizeMarket(inputs);
  assert.strictEqual(m.windowHigh, 111);
  assert.strictEqual(m.windowLow, 99);
  assert.strictEqual(m.changePct['15m'], 0); // already at 110 fifteen minutes ago
  assert.strictEqual(m.changePct['1h'], 10); // 100 -> 110
  assert.strictEqual(m.changePct['4h'], 10); // still 100 four hours ago
  assert.strictEqual(m.lastHourHigh, 111);
});

// ================================================================ analyst
test('analyst.runIndependentAnalysis: every outcome is a status object, never a throw', async () => {
  const inputs = makeInputs();
  const cases = [
    ['ok', 'OK'], ['timeout', 'TIMEOUT'], ['rate-limit', 'RATE_LIMITED'], ['error', 'ERROR'],
    ['malformed', 'ERROR'], ['schema-invalid', 'ERROR'], ['empty', 'UNAVAILABLE'],
  ];
  for (const [behavior, status] of cases) {
    // eslint-disable-next-line no-await-in-loop
    const r = await analyst.runIndependentAnalysis(inputs, { providerOverride: makeFakeProvider(behavior) });
    assert.strictEqual(r.status, status, behavior);
    assert.strictEqual(r.status === 'OK', r.analysis !== null);
  }
});

test('analyst: truncated output (MAX_TOKENS) gets an actionable reason', async () => {
  const truncating = { analyze: async () => ({ text: '{"conclusion": "UP", "conf', usage: null, finishReason: 'MAX_TOKENS', blocked: false }) };
  const r = await analyst.runIndependentAnalysis(makeInputs(), { providerOverride: truncating });
  assert.strictEqual(r.status, 'ERROR');
  assert.match(r.reason, /GEMINI_MAX_OUTPUT_TOKENS/);
});

test('analyst: not configured -> UNAVAILABLE with the specific missing setting (no call is made)', async () => {
  await withGemini({ apiKey: '', model: '' }, async () => {
    const r = await analyst.runIndependentAnalysis(makeInputs(), {});
    assert.strictEqual(r.status, 'UNAVAILABLE');
    assert.match(r.reason, /GEMINI_API_KEY/);
  });
  await withGemini({ apiKey: 'k', model: '' }, async () => {
    const r = await analyst.runFinalSynthesis({ inputs: makeInputs(), bot: null, ai: okAi(), comparison: compareAnalyses(null, okAi()) }, {});
    assert.strictEqual(r.status, 'UNAVAILABLE');
    assert.match(r.reason, /GEMINI_MODEL/);
  });
});

test('analyst.runFinalSynthesis: validated output, guardrails applied, failures are statuses', async () => {
  const { inputs, signal } = await realSignal({ direction: 'UP' });
  const bot = { status: 'OK', signal, expiryPerf: null };
  const ai = okAi({ conclusion: 'DOWN' });
  const comparison = compareAnalyses(signal, ai);
  const good = await analyst.runFinalSynthesis({ inputs, bot, ai, comparison }, { providerOverride: makeFakeProvider('ok', { synthesis: { overallView: 'UP', confidence: 'HIGH' } }) });
  assert.strictEqual(good.status, 'OK');
  assert.strictEqual(good.synthesis.confidence, 'LOW'); // disagreement caps HIGH
  const failures = { malformed: 'ERROR', 'schema-invalid': 'ERROR', timeout: 'TIMEOUT', 'rate-limit': 'RATE_LIMITED', empty: 'UNAVAILABLE' };
  for (const [behavior, status] of Object.entries(failures)) {
    // eslint-disable-next-line no-await-in-loop
    const r = await analyst.runFinalSynthesis({ inputs, bot, ai, comparison }, { providerOverride: makeFakeProvider({ synthesis: behavior }) });
    assert.strictEqual(r.status, status, behavior);
    assert.strictEqual(r.synthesis, null);
  }
});

test('confidence guardrails only ever LOWER confidence', () => {
  const s = (confidence) => ({ overallView: 'UP', confidence });
  const g = analyst.applyConfidenceGuardrails;
  const cases = [
    [{ relationship: 'AGREEMENT' }, 'HIGH', 'HIGH', false],
    [{ relationship: 'PARTIAL_AGREEMENT' }, 'HIGH', 'MEDIUM', true],
    [{ relationship: 'PARTIAL_AGREEMENT' }, 'LOW', 'LOW', false],
    [{ relationship: 'DISAGREEMENT' }, 'MEDIUM', 'LOW', true],
    [{ relationship: 'DISAGREEMENT' }, 'LOW', 'LOW', false],
    [{ relationship: 'INSUFFICIENT_DATA' }, 'HIGH', 'MEDIUM', true],
    [{ relationship: 'AGREEMENT', stale: true }, 'HIGH', 'LOW', true],
    [{ relationship: 'AGREEMENT', stale: true }, 'LOW', 'LOW', false],
  ];
  cases.forEach(([facts, from, to, noted]) => {
    const out = g(s(from), facts);
    assert.strictEqual(out.confidence, to, JSON.stringify([facts, from]));
    assert.strictEqual(!!out.confidenceNote, noted);
  });
});

// ================================================================ comparison
test('comparison: bot unavailable is reported, not crashed on', async () => {
  const withAi = compareAnalyses(null, okAi(), 'engine exploded');
  assert.strictEqual(withAi.relationship, 'INSUFFICIENT_DATA');
  assert.strictEqual(withAi.bot.available, false);
  assert.match(withAi.summary, /Bot analysis unavailable \(engine exploded\)/);
  assert.strictEqual(withAi.ai.available, true);

  const neither = compareAnalyses(null, { status: 'TIMEOUT', reason: 't/o' }, 'x');
  assert.match(neither.summary, /Neither analysis is available/);
});

test('comparison: existing bot-vs-AI classification is unchanged', async () => {
  const { signal: up } = await realSignal({ direction: 'UP', calibratedProbability: 70, qualityLabel: 'HIGH' });
  assert.ok(['AGREEMENT', 'PARTIAL_AGREEMENT'].includes(compareAnalyses(up, okAi({ conclusion: 'UP' })).relationship));
  assert.strictEqual(compareAnalyses(up, okAi({ conclusion: 'DOWN' })).relationship, 'DISAGREEMENT');
  assert.strictEqual(compareAnalyses(up, okAi({ conclusion: 'NO_VIEW' })).relationship, 'PARTIAL_AGREEMENT');
  const noTrade = { ...up, direction: 'NO_TRADE', noTradeReasons: ['r'] };
  assert.strictEqual(compareAnalyses(noTrade, okAi({ conclusion: 'NO_VIEW' })).relationship, 'AGREEMENT');
  const aiDown = compareAnalyses(up, { status: 'TIMEOUT', reason: 'x' });
  assert.strictEqual(aiDown.relationship, 'INSUFFICIENT_DATA');
  assert.strictEqual(aiDown.bot.available, true);
});

// ================================================================ Gemini provider (fetch stubbed)
function stubFetch(handler) {
  const calls = [];
  const saved = global.fetch;
  global.fetch = (url, init) => { calls.push({ url, init }); return handler(url, init, calls.length); };
  return { calls, restore: () => { global.fetch = saved; } };
}
const okBody = (text = '{}') => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] }), text: async () => '' });
const failBody = (status, message = 'nope') => ({ ok: false, status, json: async () => ({}), text: async () => message });
const hangUntilAborted = (url, init) => new Promise((resolve, reject) => {
  init.signal.addEventListener('abort', () => { const e = new Error('The operation was aborted'); e.name = 'AbortError'; reject(e); });
});

test('geminiProvider: model and key come from config; the right prompt per kind; output-token cap from config', async () => {
  const f = stubFetch(async () => okBody('{"a":1}'));
  try {
    await withGemini({ apiKey: 'KEY1', model: 'model-from-env', maxOutputTokens: 1234 }, async () => {
      await geminiProvider.analyze({ context: { hello: 'ctx' }, language: 'en', kind: 'independent' });
      await geminiProvider.analyze({ context: { hello: 'ctx' }, language: 'en', kind: 'synthesis' });
    });
    assert.strictEqual(f.calls.length, 2);
    f.calls.forEach((c) => {
      // Auth goes via the x-goog-api-key header (Google's current guidance),
      // not the older ?key= query string - so the key must never appear in
      // the URL itself (which can end up in logs/error messages).
      assert.ok(c.url.includes('/models/model-from-env:generateContent'), c.url);
      assert.ok(!c.url.includes('KEY1'), 'API key must not appear in the URL');
      assert.strictEqual(c.init.headers['x-goog-api-key'], 'KEY1');
      assert.strictEqual(JSON.parse(c.init.body).generationConfig.maxOutputTokens, 1234);
    });
    assert.match(JSON.parse(f.calls[0].init.body).contents[0].parts[0].text, /independent market analyst/);
    assert.match(JSON.parse(f.calls[1].init.body).contents[0].parts[0].text, /final research synthesizer/);
  } finally { f.restore(); }
});

test('geminiProvider: refuses to call without GEMINI_MODEL (no silent default)', async () => {
  const f = stubFetch(async () => okBody());
  try {
    await withGemini({ apiKey: 'k', model: '' }, async () => {
      await assert.rejects(() => geminiProvider.analyze({ context: {}, kind: 'independent' }), /GEMINI_MODEL is not set/);
    });
    assert.strictEqual(f.calls.length, 0);
  } finally { f.restore(); }
});

test('geminiProvider: a caller abort cancels the in-flight request, is a timeout-shaped error, and is not retried', async () => {
  const f = stubFetch(hangUntilAborted);
  try {
    await withGemini({ apiKey: 'k', model: 'm', maxRetries: 2, timeoutMs: 5000 }, async () => {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 20);
      await assert.rejects(
        () => geminiProvider.analyze({ context: {}, kind: 'independent', signal: ac.signal }),
        (err) => err.isTimeout === true && err.cancelled === true && /workflow deadline/.test(err.message),
      );
    });
    assert.strictEqual(f.calls.length, 1, 'no retry after the workflow deadline');
  } finally { f.restore(); }
});

test('geminiProvider: its own per-call timeout is a timeout (not "cancelled") and is retried within budget', async () => {
  const f = stubFetch(hangUntilAborted);
  try {
    await withGemini({ apiKey: 'k', model: 'm', maxRetries: 1, timeoutMs: 30 }, async () => {
      await assert.rejects(
        () => geminiProvider.analyze({ context: {}, kind: 'independent' }),
        (err) => err.isTimeout === true && !err.cancelled && /timed out after 30ms/.test(err.message),
      );
    });
    assert.strictEqual(f.calls.length, 2);
  } finally { f.restore(); }
});

test('geminiProvider: retries a 5xx once; never retries a 429; a 404 points at GEMINI_MODEL', async () => {
  let n = 0;
  let f = stubFetch(async () => { n += 1; return n === 1 ? failBody(503) : okBody('{"ok":true}'); });
  try {
    await withGemini({ apiKey: 'k', model: 'm', maxRetries: 1 }, async () => {
      const r = await geminiProvider.analyze({ context: {}, kind: 'independent' });
      assert.strictEqual(r.text, '{"ok":true}');
    });
    assert.strictEqual(f.calls.length, 2);
  } finally { f.restore(); }

  f = stubFetch(async () => failBody(429, 'quota'));
  try {
    await withGemini({ apiKey: 'k', model: 'm', maxRetries: 2 }, async () => {
      await assert.rejects(() => geminiProvider.analyze({ context: {}, kind: 'independent' }), (e) => e.isRateLimit === true);
    });
    assert.strictEqual(f.calls.length, 1);
  } finally { f.restore(); }

  f = stubFetch(async () => failBody(404, 'models/old-model is not found'));
  try {
    await withGemini({ apiKey: 'k', model: 'old-model', maxRetries: 0 }, async () => {
      await assert.rejects(() => geminiProvider.analyze({ context: {}, kind: 'independent' }), /check GEMINI_MODEL/);
    });
  } finally { f.restore(); }
});

test('geminiProvider: safety-blocked responses come back as blocked (not thrown)', async () => {
  const f = stubFetch(async () => ({ ok: true, status: 200, json: async () => ({ promptFeedback: { blockReason: 'SAFETY' } }), text: async () => '' }));
  try {
    await withGemini({ apiKey: 'k', model: 'm' }, async () => {
      const r = await geminiProvider.analyze({ context: {}, kind: 'independent' });
      assert.strictEqual(r.blocked, true);
      assert.strictEqual(r.text, null);
    });
  } finally { f.restore(); }
  await sleep(1);
});

run('AI layer');
