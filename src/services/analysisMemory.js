// ---- Short-lived conversation memory ----
// Lets a follow-up like "explain in Roman Urdu" or "sirf differences
// batao" reuse the LAST full analysis for that channel/user instead of
// re-fetching market data and re-calling the AI (section O + cost
// control). Redis-backed (via redisStore.js, same client as everything
// else) with a short TTL so it survives a process restart within that
// window but never becomes a long-term store of anything.
//
// Per section O: "Do not allow conversation memory to silently alter
// market data or analytical calculations." This module ONLY stores and
// retrieves already-finished analysis results - it never feeds back into
// binaryEngine, the AI prompt, or any calculation. A follow-up that reuses
// memory re-FORMATS the stored result; it never recomputes it differently
// based on conversation history.

const store = require('./redisStore');
const config = require('./../config');

function memKey(scopeId) {
  return `market:lastanalysis:${scopeId}`;
}

// `scopeId` should be something stable per conversation thread - e.g. the
// Discord channel id, or `${channelId}:${userId}` if per-user memory is
// preferred. The command layer decides which; this module is agnostic.
async function saveLastAnalysis(scopeId, record) {
  const ttlSeconds = Math.max(60, Math.round(config.ai.memoryTtlMinutes * 60));
  const payload = JSON.stringify({ ...record, savedAt: Date.now() });
  // Upstash REST client: set with an expiry option.
  await store.redis.set(memKey(scopeId), payload, { ex: ttlSeconds });
}

async function getLastAnalysis(scopeId) {
  const raw = await store.redis.get(memKey(scopeId));
  if (!raw) return null;
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const ageMs = Date.now() - (parsed.savedAt || 0);
  const ttlMs = Math.max(60, Math.round(config.ai.memoryTtlMinutes * 60)) * 1000;
  if (ageMs > ttlMs) return null; // belt-and-suspenders in case the store didn't honor TTL
  return parsed;
}

module.exports = { saveLastAnalysis, getLastAnalysis };
