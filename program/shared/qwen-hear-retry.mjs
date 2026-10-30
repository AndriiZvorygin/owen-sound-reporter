const DEFAULT_RETRY_DELAY_MS = 10_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

export function isRetryableHearError(message = "") {
  return /timed out waiting for transcription result|request failed|execution failed|ECONNRESET|ECONNREFUSED|socket hang up|fetch failed|out of memory|allocation on device|cuda.*memory|operation not permitted/iu.test(String(message || ""));
}

export function hearRetryDelayMs(attempt, {
  baseMs = positiveNumber(process.env.QWEN_HEAR_RETRY_DELAY_MS, DEFAULT_RETRY_DELAY_MS),
  maxMs = positiveNumber(process.env.QWEN_HEAR_RETRY_MAX_DELAY_MS, DEFAULT_MAX_RETRY_DELAY_MS),
} = {}) {
  const retryNumber = Math.max(1, Math.floor(Number(attempt) || 1));
  const base = Math.max(0, Number(baseMs) || 0);
  const maximum = Math.max(base, Number(maxMs) || 0);
  return Math.min(maximum, base * (2 ** (retryNumber - 1)));
}
