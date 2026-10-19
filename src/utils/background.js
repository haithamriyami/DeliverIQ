import { waitUntil, getDeadline } from '@vercel/functions';

/** True when running inside a Vercel Function request that supports waitUntil. */
export function canRunInBackground() {
  const ctx = globalThis[Symbol.for('@vercel/request-context')]?.get?.();
  return Boolean(ctx?.waitUntil);
}

/** Keep the invocation alive for this promise after the response is sent. */
export function runInBackground(promise) {
  const safe = Promise.resolve(promise).catch((err) => console.error('[background]', err?.message || err));
  if (canRunInBackground()) {
    waitUntil(safe);
    return true;
  }
  return false;
}

/**
 * How long a background sender may keep going in this invocation.
 * Uses Vercel's real invocation deadline when available (it follows maxDuration in
 * vercel.json), otherwise SEND_RUN_SECONDS (default 270, matching maxDuration 300).
 * A safety margin is kept so an email is never cut off mid send.
 */
export function sendRunBudgetMs({ safetyMs = 25000, now = Date.now(), deadline = getDeadline() } = {}) {
  const fallbackMs = Number(process.env.SEND_RUN_SECONDS || 270) * 1000;
  const left = deadline ? deadline.getTime() - now : fallbackMs + safetyMs;
  return Math.max(0, Math.min(left - safetyMs, fallbackMs));
}
