require('./helpers/stubDeps');
const assert = require('assert');
const { test, run } = require('./testKit');
const { makeCandles, sleep } = require('./helpers/fixtures');
const { makeFakeRedis } = require('./helpers/fakeRedis');
const { makeGoodResponse, makeGoodSynthesis } = require('../src/services/ai/fakeProvider');
const store = require('../src/services/redisStore');
const binaryStore = require('../src/services/binaryStore');
const config = require('../src/config');
const twelvedata = require('../src/services/twelvedata');
const { handleMessage, WAITING_TEXT } = require('../src/index');

// ---- the full REAL chain except the outside world: real routeCommand ->
// real market command -> real workflow -> real bot engine -> real
// geminiProvider/prompt/schema, with only Twelve Data, Gemini's HTTP endpoint
// and Redis faked at their edges. ----
config.ai.gemini.apiKey = 'test-key';
config.ai.gemini.model = 'test-model-x';
config.ai.gemini.maxRetries = 0;

let redis;
let tdCalls;
let geminiRequests;
let geminiDelayMs;

function resetWorld({ geminiDelay = 0 } = {}) {
  redis = makeFakeRedis();
  store.redis = redis;
  tdCalls = 0;
  geminiRequests = [];
  geminiDelayMs = geminiDelay;
}

twelvedata.getTimeSeries = async (symbol, interval, n) => {
  tdCalls += 1;
  return makeCandles({ count: n, endTime: Date.now() - 60000 });
};
twelvedata.getCurrentPrice = async () => { tdCalls += 1; return 1.0801; };

global.fetch = async (url, init) => {
  const prompt = JSON.parse(init.body).contents[0].parts[0].text;
  const kind = prompt.includes('final research synthesizer') ? 'synthesis' : 'independent';
  geminiRequests.push({ url, prompt, kind, startedAt: Date.now() });
  if (geminiDelayMs) await sleep(geminiDelayMs);
  const text = kind === 'synthesis' ? makeGoodSynthesis({ overallView: 'NO_VIEW', confidence: 'LOW' }) : makeGoodResponse({ conclusion: 'NO_VIEW', confidence: 'LOW' });
  return {
    ok: true,
    status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } }),
    text: async () => '',
  };
};

// A fake Discord message that logs every outgoing call in order.
function makeMessage(text, { channelId = 'chan-a', failFirstReply = false, failEdit = false } = {}) {
  const log = [];
  let replyCount = 0;
  const sent = {
    edit: async (content) => {
      log.push({ op: 'edit', content, at: Date.now() });
      if (failEdit) throw new Error('Unknown Message');
    },
  };
  const message = {
    author: { bot: false, tag: 'tester#0001' },
    content: text,
    channel: {
      id: channelId,
      send: async (content) => { log.push({ op: 'channel.send', content, at: Date.now() }); },
    },
    reply: async (content) => {
      replyCount += 1;
      if (failFirstReply && replyCount === 1) throw new Error('Missing Permissions');
      log.push({ op: 'reply', content, at: Date.now() });
      return sent;
    },
  };
  return { message, log };
}

// ---------------------------------------------------------------- 5
test('5. WAITING is posted once, then EDITED into the final report - no intermediate messages', async () => {
  resetWorld({ geminiDelay: 40 });
  const { message, log } = makeMessage('!market EURUSD 4H');
  await handleMessage(message);

  assert.strictEqual(log.length, 2, `expected exactly [reply WAITING, edit final], got ${JSON.stringify(log.map((l) => l.op))}`);
  assert.strictEqual(log[0].op, 'reply');
  assert.strictEqual(log[0].content, '⏳ WAITING...');
  assert.strictEqual(log[0].content, WAITING_TEXT);
  assert.strictEqual(log[1].op, 'edit');
  assert.match(log[1].content, /^\*\*MARKET RESEARCH REPORT\*\* - EURUSD/);
  assert.ok(!log.some((l) => l.op === 'channel.send'), 'no extra messages for a report that fits');
});

test('5b. the WAITING message appears immediately - before the analysis finishes', async () => {
  resetWorld({ geminiDelay: 60 });
  const { message, log } = makeMessage('!market EURUSD 4H');
  await handleMessage(message);
  const waitingAt = log.find((l) => l.op === 'reply').at;
  const editAt = log.find((l) => l.op === 'edit').at;
  assert.ok(waitingAt <= geminiRequests[0].startedAt + 60, 'WAITING went out while Gemini was still working');
  assert.ok(editAt - waitingAt >= 100, 'final edit came only after both Gemini stages (2 x 60ms)');
});

test('5c. the real chain: one shared data fetch, two Gemini calls, model comes from configuration', async () => {
  resetWorld();
  const { message } = makeMessage('!market EURUSD 4H');
  await handleMessage(message);
  assert.strictEqual(tdCalls, 2, 'one candles request + one quote request, shared by bot and AI');
  assert.deepStrictEqual(geminiRequests.map((r) => r.kind), ['independent', 'synthesis']);
  geminiRequests.forEach((r) => assert.ok(r.url.includes('models/test-model-x:generateContent'), r.url));
  // Independent prompt never mentions the bot's output; synthesis prompt carries both analyses.
  assert.ok(!/botAnalysis|calibratedProbability|NO_TRADE/.test(geminiRequests[0].prompt));
  assert.ok(/botAnalysis/.test(geminiRequests[1].prompt) && /independentAiAnalysis/.test(geminiRequests[1].prompt));
  // A successful bot signal is now registered for tracking (the !market
  // completed-trades fix) - exactly binaryStore.saveNew()'s own 3 writes,
  // nothing else.
  const writes = redis.writeCalls();
  assert.strictEqual(writes.length, 3, 'exactly one binaryStore.saveNew(): set + zadd + sadd');
  assert.strictEqual(writes[0].cmd, 'set');
  assert.ok(writes[0].args[0].startsWith('binary:signal:EURUSD-'), writes[0].args[0]);
  assert.strictEqual(writes[1].cmd, 'zadd');
  assert.strictEqual(writes[1].args[0], 'binary:signals:all');
  assert.strictEqual(writes[2].cmd, 'sadd');
  assert.strictEqual(writes[2].args[0], 'binary:signals:open');
});

test('5d. a report longer than one Discord message continues in chunks; the first chunk is still the edit', async () => {
  resetWorld();
  const { message, log } = makeMessage('!market EURUSD 4H');
  const longText = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} ${'y'.repeat(600)}`).join('\n\n');
  await handleMessage(message, {
    routeCommand: async (text, scope, hooks) => { await hooks.onWorkflowStart(); return longText; },
  });
  assert.strictEqual(log[0].op, 'reply');
  assert.strictEqual(log[0].content, WAITING_TEXT);
  assert.strictEqual(log[1].op, 'edit');
  const rest = log.slice(2);
  assert.ok(rest.length >= 1 && rest.every((l) => l.op === 'channel.send'));
  log.slice(1).forEach((l) => assert.ok(l.content.length <= 2000, `chunk of ${l.content.length} chars`));
  const rebuilt = log.slice(1).map((l) => l.content).join('\n\n');
  assert.strictEqual(rebuilt.replace(/\s+/g, ' '), longText.replace(/\s+/g, ' '), 'no text lost by chunking');
});

test('5e. if the WAITING message cannot be edited, the result is still delivered (as a reply)', async () => {
  resetWorld();
  const { message, log } = makeMessage('!market EURUSD 4H', { failEdit: true });
  await handleMessage(message);
  assert.deepStrictEqual(log.map((l) => l.op), ['reply', 'edit', 'reply']);
  assert.match(log[2].content, /MARKET RESEARCH REPORT/);
});

test('5f. if the WAITING message cannot even be posted, the analysis still runs and is delivered', async () => {
  resetWorld();
  const { message, log } = makeMessage('!market EURUSD 4H', { failFirstReply: true });
  await handleMessage(message);
  assert.strictEqual(geminiRequests.length, 2, 'analysis was not blocked by the failed WAITING send');
  assert.deepStrictEqual(log.map((l) => l.op), ['reply']);
  assert.match(log[0].content, /MARKET RESEARCH REPORT/);
});

test('5g. an unexpected crash after WAITING edits the WAITING message into an error (never left hanging)', async () => {
  resetWorld();
  const { message, log } = makeMessage('!market EURUSD 4H');
  await handleMessage(message, {
    routeCommand: async (text, scope, hooks) => { await hooks.onWorkflowStart(); throw new Error('handler exploded'); },
  });
  assert.deepStrictEqual(log.map((l) => l.op), ['reply', 'edit']);
  assert.strictEqual(log[0].content, WAITING_TEXT);
  assert.match(log[1].content, /Error: handler exploded/);
});

test('5h. failure states are delivered through the same edit: INSUFFICIENT_DATA, concise', async () => {
  resetWorld();
  const savedTs = twelvedata.getTimeSeries;
  twelvedata.getTimeSeries = async () => { throw new Error('Twelve Data error for EURUSD: no values returned'); };
  try {
    const { message, log } = makeMessage('!market EURUSD 4H');
    await handleMessage(message);
    assert.deepStrictEqual(log.map((l) => l.op), ['reply', 'edit']);
    assert.match(log[1].content, /INSUFFICIENT_DATA/);
    assert.strictEqual(geminiRequests.length, 0, 'no Gemini call without data');
  } finally {
    twelvedata.getTimeSeries = savedTs;
  }
});

// ------------------------------------------------------- follow-ups
test('5i. follow-ups reuse the in-process result: no WAITING message, no new fetch, no new AI call, no new Redis writes', async () => {
  resetWorld();
  const first = makeMessage('!market EURUSD 5m', { channelId: 'follow-chan' });
  await handleMessage(first.message);
  assert.deepStrictEqual(first.log.map((l) => l.op), ['reply', 'edit']);
  const td0 = tdCalls;
  const ai0 = geminiRequests.length;
  const writes0 = redis.writeCalls().length; // the fresh analysis above registers its own signal (binaryStore.saveNew)

  const second = makeMessage('!market sirf differences batao', { channelId: 'follow-chan' });
  await handleMessage(second.message);
  assert.deepStrictEqual(second.log.map((l) => l.op), ['reply'], 'instant answer, nothing to wait for');
  assert.match(second.log[0].content, /^\*\*Comparison:/);
  assert.strictEqual(tdCalls, td0);
  assert.strictEqual(geminiRequests.length, ai0);

  const third = makeMessage('!market Roman Urdu mein explain karo', { channelId: 'follow-chan' });
  await handleMessage(third.message);
  assert.deepStrictEqual(third.log.map((l) => l.op), ['reply']);
  assert.match(third.log[0].content, /MARKET RESEARCH REPORT/);
  assert.strictEqual(redis.writeCalls().length, writes0, 'follow-ups must not add any new Redis writes beyond the original fresh analysis');
});

test('5j. a follow-up in a channel with no previous analysis gets guidance (and no WAITING)', async () => {
  resetWorld();
  const { message, log } = makeMessage('!market Roman Urdu mein explain karo', { channelId: 'brand-new-chan' });
  await handleMessage(message);
  assert.deepStrictEqual(log.map((l) => l.op), ['reply']);
  assert.match(log[0].content, /koi pichli analysis bhi nahi mili/);
});

test('5k. explicit narrower views: comparison view skips the synthesis call; data-quality view skips AI entirely', async () => {
  resetWorld();
  const cmp = makeMessage('!market EURUSD 5m sirf differences batao', { channelId: 'view-chan' });
  await handleMessage(cmp.message);
  assert.deepStrictEqual(cmp.log.map((l) => l.op), ['reply', 'edit']);
  assert.match(cmp.log[1].content, /^\*\*Comparison:/);
  assert.deepStrictEqual(geminiRequests.map((r) => r.kind), ['independent']);

  resetWorld();
  const dq = makeMessage('!market Data quality check karo GBPUSD', { channelId: 'view-chan-2' });
  await handleMessage(dq.message);
  assert.deepStrictEqual(dq.log.map((l) => l.op), ['reply', 'edit']);
  assert.match(dq.log[1].content, /^\*\*Data Quality - GBPUSD/);
  assert.strictEqual(geminiRequests.length, 0);
});

test('5l. follow-up memory expires after its TTL (in-process, not Redis)', async () => {
  resetWorld();
  const { followUpMemory, FOLLOWUP_TTL_MS } = require('../src/commands/market');
  const first = makeMessage('!market EURUSD 5m', { channelId: 'ttl-chan' });
  await handleMessage(first.message);
  followUpMemory.get('ttl-chan').savedAt -= FOLLOWUP_TTL_MS + 1000;
  const second = makeMessage('!market sirf differences batao', { channelId: 'ttl-chan' });
  await handleMessage(second.message);
  assert.match(second.log[0].content, /koi pichli analysis bhi nahi mili/);
});

test('5m. a failed run does not overwrite the last good analysis a follow-up might want', async () => {
  resetWorld();
  const ok = makeMessage('!market EURUSD 5m', { channelId: 'keep-chan' });
  await handleMessage(ok.message);
  const savedTs = twelvedata.getTimeSeries;
  twelvedata.getTimeSeries = async () => { throw new Error('provider down'); };
  try {
    const bad = makeMessage('!market GBPUSD 5m', { channelId: 'keep-chan' });
    await handleMessage(bad.message);
    assert.match(bad.log[1].content, /INSUFFICIENT_DATA/);
  } finally {
    twelvedata.getTimeSeries = savedTs;
  }
  const follow = makeMessage('!market sirf differences batao', { channelId: 'keep-chan' });
  await handleMessage(follow.message);
  assert.match(follow.log[0].content, /^\*\*Comparison:/);
});

// ------------------------------------------------------- tracker registration (completed-trades fix)
test('!market registers a successful signal for tracking - retrievable via binaryStore, same shape as !analyze/!binary use', async () => {
  resetWorld();
  const { message } = makeMessage('!market EURUSD 4H');
  await handleMessage(message);

  const open = await binaryStore.getOpen();
  assert.strictEqual(open.length, 1, 'exactly one tracked signal registered for this run');
  const stored = open[0];
  assert.strictEqual(stored.symbol, 'EURUSD');
  assert.strictEqual(stored.status, 'OPEN');
  assert.strictEqual(stored.result, null);
  assert.ok(Array.isArray(stored.checkpoints) && stored.checkpoints.length > 0, 'checkpoints must be present for binaryTracker to resolve later');
  assert.ok(stored.expiryBucket && stored.expiryBucket.key, 'expiryBucket must be present so this run counts toward its own bucket\'s completed-trade history');
  assert.ok(stored.id.startsWith('EURUSD-'), stored.id);
});

test('!market does NOT register anything when there is no successful bot signal (e.g. INSUFFICIENT_DATA)', async () => {
  resetWorld();
  const savedTs = twelvedata.getTimeSeries;
  twelvedata.getTimeSeries = async () => { throw new Error('Twelve Data error for EURUSD: no values returned'); };
  try {
    const { message, log } = makeMessage('!market EURUSD 4H');
    await handleMessage(message);
    assert.match(log[1].content, /INSUFFICIENT_DATA/);
  } finally {
    twelvedata.getTimeSeries = savedTs;
  }
  assert.deepStrictEqual(redis.writeCalls(), [], 'no bot signal exists, so nothing should be registered');
  assert.deepStrictEqual(await binaryStore.getOpen(), []);
});

test('!market: a tracking-registration failure (e.g. Redis down) never breaks the delivered analysis', async () => {
  resetWorld();
  const savedSet = redis.set;
  redis.set = async () => { throw new Error('simulated Redis outage'); };
  try {
    const { message, log } = makeMessage('!market EURUSD 4H');
    await handleMessage(message);
    assert.deepStrictEqual(log.map((l) => l.op), ['reply', 'edit']);
    assert.match(log[1].content, /MARKET RESEARCH REPORT/, 'the analysis itself must still be delivered in full');
  } finally {
    redis.set = savedSet;
  }
});

test('ignores bot authors and non-command messages', async () => {
  resetWorld();
  const a = makeMessage('!market EURUSD 4H');
  a.message.author.bot = true;
  await handleMessage(a.message);
  const b = makeMessage('hello there');
  await handleMessage(b.message);
  assert.strictEqual(a.log.length + b.log.length, 0);
  assert.strictEqual(geminiRequests.length, 0);
});

run('discord UX (WAITING -> edit)');
