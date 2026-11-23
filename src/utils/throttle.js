import { DateTime } from 'luxon';

export const SEND_TIMEZONE = 'Africa/Nairobi';

export const DEFAULT_SEND_SETTINGS = Object.freeze({
  sendGapSeconds: 10,
  sendJitterSeconds: 5,
  dailySendCap: 200,
});

export const SETTINGS_LIMITS = Object.freeze({
  sendGapSeconds: { min: 5, max: 3600 },
  sendJitterSeconds: { min: 0, max: 600 },
  dailySendCap: { min: 1, max: 2000 },
});

function clampInt(value, { min, max }, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Normalize workspace settings, falling back to the owner decided defaults. */
export function normalizeSendSettings(raw = {}) {
  return {
    sendGapSeconds: clampInt(raw?.sendGapSeconds, SETTINGS_LIMITS.sendGapSeconds, DEFAULT_SEND_SETTINGS.sendGapSeconds),
    sendJitterSeconds: clampInt(raw?.sendJitterSeconds, SETTINGS_LIMITS.sendJitterSeconds, DEFAULT_SEND_SETTINGS.sendJitterSeconds),
    dailySendCap: clampInt(raw?.dailySendCap, SETTINGS_LIMITS.dailySendCap, DEFAULT_SEND_SETTINGS.dailySendCap),
  };
}

/**
 * The daily cap is a rolling 24 hours, the same way Gmail counts its own sending limit.
 * A reset at midnight let an account send a full cap in the afternoon and again right
 * after midnight, which is more than Gmail allows in 24 hours.
 */
export const SEND_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Start of the rolling cap window: 24 hours before now. */
export function sendWindowStart(now = new Date()) {
  return new Date(now.getTime() - SEND_WINDOW_MS);
}

/** A time as people in the app read it, for example "24 Nov 11:25 Nairobi time". */
export function formatSendTime(date, zone = SEND_TIMEZONE) {
  return `${DateTime.fromJSDate(new Date(date), { zone }).toFormat('d LLL HH:mm')} Nairobi time`;
}

/** Start of the current sending day (Africa/Nairobi midnight) as a JS Date. */
export function sendDayStart(now = new Date(), zone = SEND_TIMEZONE) {
  return DateTime.fromJSDate(now, { zone }).startOf('day').toJSDate();
}

/** Start of the next sending day (next Africa/Nairobi midnight). */
export function nextSendDayStart(now = new Date(), zone = SEND_TIMEZONE) {
  return DateTime.fromJSDate(now, { zone }).startOf('day').plus({ days: 1 }).toJSDate();
}

/**
 * Next time this sender may send after sending at `sentAt`.
 * Gap is at least sendGapSeconds plus a random 0..sendJitterSeconds jitter.
 */
export function computeNextSendAt(sentAt, settings, random = Math.random) {
  const { sendGapSeconds, sendJitterSeconds } = normalizeSendSettings(settings);
  const jitterMs = Math.floor(Math.max(0, Math.min(1, random())) * sendJitterSeconds * 1000);
  return new Date(sentAt.getTime() + sendGapSeconds * 1000 + jitterMs);
}

/**
 * Decide whether a sender may send right now.
 * Returns { ok: true } or { ok: false, reason, retryAt }.
 */
export function sendDecision({ now = new Date(), nextSendAt = null, sentToday = 0, settings, pausedAt = null, capResumesAt = null }) {
  const { dailySendCap } = normalizeSendSettings(settings);
  if (pausedAt) {
    return { ok: false, reason: 'paused', retryAt: null };
  }
  if (sentToday >= dailySendCap) {
    // sentToday is the count for the last 24 hours. Room frees up when the oldest of those
    // sends ages out (capResumesAt); without that, 24 hours from now is the safe upper bound.
    return { ok: false, reason: 'daily_cap', retryAt: capResumesAt ? new Date(capResumesAt) : new Date(now.getTime() + SEND_WINDOW_MS) };
  }
  if (nextSendAt && nextSendAt.getTime() > now.getTime()) {
    return { ok: false, reason: 'gap', retryAt: nextSendAt };
  }
  return { ok: true };
}

/** Typical time Gmail and the database take per email on top of the gap. */
export const SEND_OVERHEAD_MS = 1500;

/** Average time between two emails from one account with these settings. */
export function averageSendIntervalMs(settings) {
  const { sendGapSeconds, sendJitterSeconds } = normalizeSendSettings(settings);
  return (sendGapSeconds + sendJitterSeconds / 2) * 1000 + SEND_OVERHEAD_MS;
}

/** Emails per hour one account can send with these settings (ignoring the daily cap). */
export function emailsPerHour(settings) {
  return Math.floor(3600000 / averageSendIntervalMs(settings));
}

/**
 * Estimated time the last queued email goes out for one account. Respects the gap and the
 * rolling 24 hour cap: once the cap is used up, the next batch starts when room frees up
 * (capResumesAt, or 24 hours after the batch started when unknown), and each later full
 * batch 24 hours after the one before. Returns null when nothing is queued.
 */
export function estimateFinish({ now = new Date(), queued = 0, sentToday = 0, nextSendAt = null, settings, capResumesAt = null } = {}) {
  if (!queued || queued <= 0) return null;
  const { dailySendCap } = normalizeSendSettings(settings);
  const interval = averageSendIntervalMs(settings);
  let remaining = queued;
  let left = Math.max(0, dailySendCap - sentToday);
  let start = Math.max(now.getTime(), nextSendAt ? new Date(nextSendAt).getTime() : 0);
  let refill = capResumesAt ? new Date(capResumesAt).getTime() : null;
  for (let guard = 0; guard < 3660; guard += 1) {
    const batch = Math.min(remaining, left);
    if (batch >= remaining) {
      return new Date(start + (remaining - 1) * interval);
    }
    remaining -= batch;
    const batchEnd = start + batch * interval;
    const next = refill ?? start + SEND_WINDOW_MS;
    start = Math.max(batchEnd, next);
    refill = null;
    left = dailySendCap;
  }
  return null;
}
