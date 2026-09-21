'use strict';

const GEMINI_TIMEOUT_MS = 25000;
const TOTAL_REQUEST_DEADLINE_MS = 50000;

// Verified active vision models from Google Generative Language API
const MODEL_CONFIG = {
  primary: 'gemini-2.5-flash',
  fallbacks: [
    'gemini-flash-latest',
    'gemini-2.5-flash-lite',
    'gemini-flash-lite-latest'
  ]
};

// ── Circuit Breakers (Session-Scoped, in-memory only) ─────────────────────────
// keyCircuitBreaker: Map<apiKey, { disabled: boolean, cooldownUntil: number, reason: string }>
const keyCircuitBreaker = new Map();
// modelCircuitBreaker: Map<modelName, { permanentlyUnavailable: boolean, cooldownUntil: number, reason: string }>
const modelCircuitBreaker = new Map();

function isKeyAvailable(apiKey) {
  if (!apiKey) return false;
  const state = keyCircuitBreaker.get(apiKey);
  if (!state) return true;
  if (state.disabled) return false; // 401 / 403 permanently bad in this session
  if (state.cooldownUntil && Date.now() < state.cooldownUntil) return false; // 429 in cooldown
  return true;
}

function recordKeySuccess(apiKey) {
  if (keyCircuitBreaker.has(apiKey)) {
    const state = keyCircuitBreaker.get(apiKey);
    if (!state.disabled) {
      keyCircuitBreaker.delete(apiKey);
    }
  }
}

function recordKeyError(apiKey, httpStatus, reason) {
  if (!apiKey) return;
  if (httpStatus === 401 || httpStatus === 403) {
    // Bad or unauthorized key - disable permanently for this session
    keyCircuitBreaker.set(apiKey, { disabled: true, cooldownUntil: Infinity, reason: reason || 'Invalid or unauthorized API key' });
  } else if (httpStatus === 429) {
    // Rate limit - cooldown for 60 seconds
    keyCircuitBreaker.set(apiKey, { disabled: false, cooldownUntil: Date.now() + 60000, reason: reason || 'Rate limit (429)' });
  }
}

function isModelAvailable(model) {
  if (!model) return false;
  const state = modelCircuitBreaker.get(model);
  if (!state) return true;
  if (state.permanentlyUnavailable) return false; // 404 / 400 not found
  if (state.cooldownUntil && Date.now() < state.cooldownUntil) return false; // 503 / high demand in cooldown
  return true;
}

function recordModelUnavailable(model, reason) {
  modelCircuitBreaker.set(model, { permanentlyUnavailable: true, cooldownUntil: Infinity, reason: reason || 'Model not found' });
}

function recordModelBusy(model, cooldownMs = 30000, reason = 'High demand / 503') {
  modelCircuitBreaker.set(model, { permanentlyUnavailable: false, cooldownUntil: Date.now() + cooldownMs, reason });
}

function recordModelSuccess(model) {
  if (modelCircuitBreaker.has(model)) {
    const state = modelCircuitBreaker.get(model);
    if (!state.permanentlyUnavailable) {
      modelCircuitBreaker.delete(model);
    }
  }
}

function getMimeTypeFromBase64(str) {
  if (!str) return 'image/jpeg';
  const match = str.match(/^data:(image\/[a-zA-Z0-9.-]+);base64,/);
  if (match) return match[1];
  if (str.startsWith('/9j/')) return 'image/jpeg';
  if (str.startsWith('iVBORw0KGgo')) return 'image/png';
  return 'image/jpeg';
}

module.exports = {
  GEMINI_TIMEOUT_MS,
  TOTAL_REQUEST_DEADLINE_MS,
  MODEL_CONFIG,
  isKeyAvailable,
  recordKeySuccess,
  recordKeyError,
  isModelAvailable,
  recordModelUnavailable,
  recordModelBusy,
  recordModelSuccess,
  getMimeTypeFromBase64
};
