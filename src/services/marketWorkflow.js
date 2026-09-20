// ---- Unified !market research workflow ----
//
//   COMMAND
//      |
//      v
//   fetch RAW market data once (candles + live quote; no analysis)
//      |
//      +-----------------------------+
//      v                             v
//   BOT ANALYSIS                 INDEPENDENT AI ANALYSIS
//   (deterministic engine,       (Gemini; sees ONLY the raw candles -
//    calibration read)            never the bot's output)
//      |                             |
//      +--------------+--------------+
//                     v
//              deterministic comparison
//                     |
//                     v
//              FINAL AI SYNTHESIS (Gemini; sees both analyses)
//                     |
//                     v
//               result object -> Discord formatting (commands/market.js)
//
// Rules this module enforces (and tests/market-workflow.test.js checks):
//  * Both branches are attached to the same in-flight data fetch in the same
//    tick. Neither waits for the other; the AI branch never receives the bot
//    result (it isn't even a parameter of the AI branch).
//  * All intermediate state (raw candles, bot signal, AI analysis,
//    comparison) lives in local variables of ONE runMarketWorkflow() call
//    and is discarded when it returns. Nothing here touches Redis - the
//    only Redis traffic in the whole flow is the bot's existing READ of
//    calibration counters inside binaryEngine.generateBinarySignal.
//  * One overall deadline (config.market.workflowTimeoutMs). When it fires,
//    in-flight Gemini calls are aborted and whatever finished is reported.
//  * Failure isolation: bot failure never cancels the AI branch; AI failure
//    never discards the bot analysis; bad/insufficient market data
//    short-circuits BEFORE any AI call and yields INSUFFICIENT_DATA with no
//    direction or probability.
//  * runMarketWorkflow never throws.
//
// Result `outcome` values:
//   'REPORT'            final synthesis produced (mode 'report')
//   'ANALYSES'          analyses available; synthesis intentionally not part
//                       of this mode (comparison/data-quality views)
//   'DEGRADED'          synthesis was wanted but couldn't be produced (AI
//                       unavailable, synthesis failed, or deadline) - at
//                       least one analysis is still returned, never dropped
//   'INSUFFICIENT_DATA' market data missing/invalid/too short - no analysis
//   'TIMEOUT'           deadline hit and nothing usable finished
//   'ERROR'             both analyses failed for non-timeout reasons

const config = require('../config');
const logger = require('../utils/logger');
const binaryEngine = require('./binaryEngine');
const calibrationSvc = require('./calibration');
const dataQualitySvc = require('./dataQuality');
const analyst = require('./ai/analyst');
const { compareAnalyses } = require('./ai/comparison');
const { summarizeMarket, collectLimitations } = require('./ai/marketContext');

// Which stages a request needs. 'report' is the default unified workflow;
// the other two serve the pre-existing narrower !market views
// (differences-only / reasoning / data-quality) without paying for a
// synthesis (or, for data quality, any AI) call nobody will read.
const MODES = {
  report: { runAI: true, synthesize: true },
  comparison: { runAI: true, synthesize: false },
  dataquality: { runAI: false, synthesize: false },
};

async function runBotBranch(inputs) {
  const startedAt = Date.now();
  try {
    // Reuses the raw snapshot - no second market-data fetch.
    const signal = await binaryEngine.generateBinarySignal(inputs.symbol, inputs.duration, inputs);
    let expiryPerf = null;
    try {
      expiryPerf = await calibrationSvc.getExpiryPerf(signal.expiryBucket.key); // Redis READ only
    } catch (err) {
      logger.warn(`Historical performance lookup failed (continuing without it): ${err.message}`);
    }
    return { status: 'OK', signal, expiryPerf, reason: null, latencyMs: Date.now() - startedAt };
  } catch (err) {
    logger.warn(`Bot analysis failed for ${inputs.symbol}: ${err.message}`);
    return { status: 'ERROR', signal: null, expiryPerf: null, reason: err.message, latencyMs: Date.now() - startedAt };
  }
}

function defaultDeps() {
  return {
    fetchInputs: (symbol, minutes) => binaryEngine.fetchSignalInputs(symbol, minutes),
    runBot: runBotBranch,
    runIndependentAI: (inputs, opts) => analyst.runIndependentAnalysis(inputs, opts),
    runSynthesis: (payload, opts) => analyst.runFinalSynthesis(payload, opts),
  };
}

// Resolves with `promise`'s value, or with onDeadline() if `signal` aborts
// first, or with onFailure(err) if `promise` rejects. Never rejects itself
// and never leaves a rejection unhandled (the branch functions are meant to
// return failure results rather than throw, but an injected/buggy one must
// not be able to hang or crash the workflow).
function raceDeadline(promise, signal, onDeadline, onFailure) {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(onDeadline());
      // Still attach handlers so a later rejection can't go unhandled.
      promise.then(() => {}, () => {});
      return;
    }
    const onAbort = () => resolve(onDeadline());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        resolve(onFailure(err));
      },
    );
  });
}

function classifyDataFailure(err) {
  if (err && err.code === 'INSUFFICIENT_DATA') return 'TOO_FEW_CANDLES';
  if (err && err.code === 'INVALID_DATA') return 'INVALID_DATA';
  return 'DATA_FETCH_FAILED';
}

async function runMarketWorkflow(request, options = {}) {
  const startedAt = Date.now();
  const mode = MODES[options.mode] || MODES.report;
  const modeName = MODES[options.mode] ? options.mode : 'report';
  const deps = { ...defaultDeps(), ...(options.deps || {}) };
  const timeoutMs = options.timeoutMs != null ? options.timeoutMs : config.market.workflowTimeoutMs;
  const aiOptions = { ...(options.aiOptions || {}), language: request.language || 'en' };

  // ---- temporary in-memory workflow state (dropped when this call returns) ----
  const state = {
    phase: 'DATA', inputs: null, bot: null, ai: null, comparison: null, synthesis: null,
  };

  const deadline = new AbortController();
  // Deliberately NOT unref'd: the deadline must fire even if nothing else is
  // keeping the process alive. It is always cleared in the `finally` below,
  // so it never outlives the run.
  const timer = setTimeout(() => deadline.abort(), timeoutMs);

  const base = { request, mode: modeName, startedAt };
  const finish = (fields) => {
    const finishedAt = Date.now();
    const result = {
      ...base,
      market: null, bot: null, ai: null, comparison: null, synthesis: null, limitations: [], reason: null, reasonCode: null,
      ...fields,
      finishedAt,
      totalMs: finishedAt - startedAt,
    };
    logger.info(`market workflow ${request.symbol} ${request.horizonMinutes}m mode=${modeName} outcome=${result.outcome}${result.reasonCode ? `(${result.reasonCode})` : ''} total=${result.totalMs}ms bot=${result.bot ? `${result.bot.status}/${result.bot.latencyMs}ms` : '-'} ai=${result.ai ? `${result.ai.status}/${result.ai.latencyMs}ms` : '-'} synthesis=${result.synthesis ? `${result.synthesis.status}/${result.synthesis.latencyMs}ms` : '-'}`);
    return result;
  };

  try {
    // ---- 1. shared RAW data fetch (starts immediately; no analysis in it) ----
    const inputsP = (async () => {
      try {
        const inputs = await deps.fetchInputs(request.symbol, request.horizonMinutes);
        const dq = dataQualitySvc.validateCandleSeries(inputs.candles);
        if (!dq.ok) {
          const err = new Error(`market data failed validation (${dq.issues.length ? dq.issues.join('; ') : 'too few valid candles'})`);
          err.code = 'INVALID_DATA';
          throw err;
        }
        return { ok: true, inputs };
      } catch (err) {
        return { ok: false, error: err };
      }
    })();
    const inputsRace = raceDeadline(inputsP, deadline.signal, () => ({
      ok: false, timedOut: true, error: new Error(`market data fetch did not finish within ${Math.round(timeoutMs / 1000)}s`),
    }));

    // ---- 2. fork: AI first (its network latency dominates), then the bot.
    // Both hang off the SAME data promise, are registered in the same tick,
    // and neither references the other. A failed/timed-out data stage skips
    // both (null) - no AI call is made without data. ----
    const aiP = mode.runAI
      ? raceDeadline(
        inputsRace.then((r) => (r.ok ? deps.runIndependentAI(r.inputs, { ...aiOptions, signal: deadline.signal }) : null)),
        deadline.signal,
        () => ({ status: 'TIMEOUT', reason: `independent AI analysis did not finish within ${Math.round(timeoutMs / 1000)}s`, analysis: null, usage: null, latencyMs: Date.now() - startedAt }),
        (err) => ({ status: 'ERROR', reason: `independent AI analysis crashed: ${err.message}`, analysis: null, usage: null, latencyMs: Date.now() - startedAt }),
      )
      : Promise.resolve(null);
    const botP = raceDeadline(
      inputsRace.then((r) => (r.ok ? deps.runBot(r.inputs) : null)),
      deadline.signal,
      () => ({ status: 'TIMEOUT', signal: null, expiryPerf: null, reason: `bot analysis did not finish within ${Math.round(timeoutMs / 1000)}s`, latencyMs: Date.now() - startedAt }),
      (err) => ({ status: 'ERROR', signal: null, expiryPerf: null, reason: `bot analysis crashed: ${err.message}`, latencyMs: Date.now() - startedAt }),
    );

    const inputsResult = await inputsRace;
    if (!inputsResult.ok) {
      const err = inputsResult.error;
      if (inputsResult.timedOut) {
        return finish({ outcome: 'TIMEOUT', reasonCode: 'DATA_TIMEOUT', reason: err.message });
      }
      return finish({
        outcome: 'INSUFFICIENT_DATA',
        reasonCode: classifyDataFailure(err),
        reason: err.message,
      });
    }
    state.inputs = inputsResult.inputs;
    state.phase = 'ANALYSIS';

    // ---- 3. wait for BOTH branches ----
    const [ai, bot] = await Promise.all([aiP, botP]);
    state.ai = ai;
    state.bot = bot;
    const botOK = !!bot && bot.status === 'OK';
    const aiOK = !!ai && ai.status === 'OK';

    const deadlineHit = deadline.signal.aborted;
    const market = summarizeMarket(state.inputs);
    const limitations = collectLimitations({ inputs: state.inputs, bot, ai, skipAI: !mode.runAI });
    const strip = (branch) => (branch ? { ...branch } : null);

    // ---- data-quality-only view: bot only ----
    if (!mode.runAI) {
      if (botOK) return finish({ outcome: 'ANALYSES', market, bot: strip(bot), limitations });
      return finish({
        outcome: deadlineHit ? 'TIMEOUT' : 'ERROR',
        reasonCode: deadlineHit ? 'WORKFLOW_TIMEOUT' : 'BOT_FAILED',
        reason: bot ? bot.reason : 'bot analysis did not run',
        market, bot: strip(bot), limitations,
      });
    }

    // ---- nothing usable at all ----
    if (!botOK && !aiOK) {
      return finish({
        outcome: deadlineHit ? 'TIMEOUT' : 'ERROR',
        reasonCode: deadlineHit ? 'WORKFLOW_TIMEOUT' : 'BOTH_FAILED',
        reason: `bot: ${bot.reason}; AI: ${ai.status} - ${ai.reason}`,
        market, bot: strip(bot), ai: strip(ai), limitations,
      });
    }

    // ---- 4. deterministic comparison of whatever exists ----
    state.comparison = compareAnalyses(botOK ? bot.signal : null, ai, bot.reason);
    const comparison = state.comparison;

    if (!mode.synthesize) {
      return finish({ outcome: 'ANALYSES', market, bot: strip(bot), ai: strip(ai), comparison, limitations });
    }

    // ---- 5. FINAL SYNTHESIS. It needs the independent AI analysis to
    // exist: if the AI stage failed there is nothing for a second model call
    // to compare, and it would most likely fail the same way - so degrade
    // straight to the deterministic report (bot analysis kept, AI failure
    // stated) instead of spending more of the user's wait on it. ----
    if (!aiOK) {
      return finish({
        outcome: 'DEGRADED',
        reasonCode: deadlineHit ? 'WORKFLOW_TIMEOUT' : 'AI_UNAVAILABLE',
        reason: `independent AI analysis ${ai.status}: ${ai.reason}`,
        market, bot: strip(bot), ai: strip(ai), comparison, limitations,
      });
    }
    if (deadlineHit) {
      return finish({
        outcome: 'DEGRADED', reasonCode: 'WORKFLOW_TIMEOUT', reason: 'no time left for the final synthesis', market, bot: strip(bot), ai: strip(ai), comparison, limitations,
      });
    }

    state.phase = 'SYNTHESIS';
    const synthesis = await raceDeadline(
      deps.runSynthesis({ inputs: state.inputs, bot, ai, comparison }, { ...aiOptions, signal: deadline.signal }),
      deadline.signal,
      () => ({ status: 'TIMEOUT', reason: `final synthesis did not finish within ${Math.round(timeoutMs / 1000)}s`, synthesis: null, usage: null, latencyMs: Date.now() - startedAt }),
      (err) => ({ status: 'ERROR', reason: `final synthesis crashed: ${err.message}`, synthesis: null, usage: null, latencyMs: Date.now() - startedAt }),
    );
    state.synthesis = synthesis;

    if (synthesis.status === 'OK') {
      return finish({
        outcome: 'REPORT', market, bot: strip(bot), ai: strip(ai), comparison, synthesis: strip(synthesis), limitations,
      });
    }
    return finish({
      outcome: 'DEGRADED',
      reasonCode: deadline.signal.aborted ? 'WORKFLOW_TIMEOUT' : 'SYNTHESIS_FAILED',
      reason: `final synthesis ${synthesis.status}: ${synthesis.reason}`,
      market, bot: strip(bot), ai: strip(ai), comparison, synthesis: strip(synthesis), limitations,
    });
  } catch (err) {
    // Belt and braces - every branch above already converts its own
    // failures into results, so reaching this means a bug, not a market
    // condition. Still must not throw into the Discord handler.
    logger.error(`market workflow crashed unexpectedly: ${err.stack || err.message}`);
    return finish({ outcome: 'ERROR', reasonCode: 'INTERNAL', reason: err.message });
  } finally {
    clearTimeout(timer);
    state.inputs = null; // drop the raw candles as soon as the run is over
  }
}

module.exports = { runMarketWorkflow, MODES };
