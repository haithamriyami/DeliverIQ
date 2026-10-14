import { DateTime } from 'luxon';

export const SEND_TIMEZONE = 'Africa/Nairobi';

export const DEFAULT_SEND_SETTINGS = Object.freeze({
  sendGapSeconds: 30,
  sendJitterSeconds: 10,
  dailySendCap: 200,
});

export const SETTINGS_LIMITS = Object.freeze({
  sendGapSeconds: { min: 30, max: 3600 },
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
export function sendDecision({ now = new Date(), nextSendAt = null, sentToday = 0, settings, pausedAt = null }) {
  const { dailySendCap } = normalizeSendSettings(settings);
  if (pausedAt) {
    return { ok: false, reason: 'paused', retryAt: null };
  }
  if (sentToday >= dailySendCap) {
    return { ok: false, reason: 'daily_cap', retryAt: nextSendDayStart(now) };
  }
  if (nextSendAt && nextSendAt.getTime() > now.getTime()) {
    return { ok: false, reason: 'gap', retryAt: nextSendAt };
  }
  return { ok: true };
}
