import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeNextSendAt,
  sendDecision,
  sendDayStart,
  nextSendDayStart,
  normalizeSendSettings,
  DEFAULT_SEND_SETTINGS,
  estimateFinish,
  emailsPerHour,
  averageSendIntervalMs,
  sendWindowStart,
  formatSendTime,
} from '../src/utils/throttle.js';
import { sendRunBudgetMs } from '../src/utils/background.js';

test('defaults are 10 s gap, 5 s jitter, 200 per day', () => {
  assert.deepEqual(normalizeSendSettings({}), { sendGapSeconds: 10, sendJitterSeconds: 5, dailySendCap: 200 });
  assert.deepEqual(normalizeSendSettings(null), { ...DEFAULT_SEND_SETTINGS });
});

test('gap can never be configured below 5 seconds', () => {
  assert.equal(normalizeSendSettings({ sendGapSeconds: 2 }).sendGapSeconds, 5);
  assert.equal(normalizeSendSettings({ sendGapSeconds: 5 }).sendGapSeconds, 5);
  assert.equal(normalizeSendSettings({ sendGapSeconds: 45 }).sendGapSeconds, 45);
});

test('next send is 10 to 15 seconds after a send by default', () => {
  const t = new Date('2026-10-14T08:00:00Z');
  const min = computeNextSendAt(t, DEFAULT_SEND_SETTINGS, () => 0);
  const max = computeNextSendAt(t, DEFAULT_SEND_SETTINGS, () => 0.999999);
  assert.equal(min.getTime() - t.getTime(), 10_000);
  assert.ok(max.getTime() - t.getTime() < 15_000);
  assert.ok(max.getTime() - t.getTime() >= 14_000);
  for (let i = 0; i < 200; i += 1) {
    const gap = computeNextSendAt(t, DEFAULT_SEND_SETTINGS).getTime() - t.getTime();
    assert.ok(gap >= 10_000 && gap <= 15_000, `gap ${gap}`);
  }
});

test('sendDecision blocks until the gap has passed', () => {
  const now = new Date('2026-10-14T08:00:10Z');
  const nextSendAt = new Date('2026-10-14T08:00:31Z');
  const blocked = sendDecision({ now, nextSendAt, sentToday: 3, settings: {} });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'gap');
  assert.equal(blocked.retryAt.getTime(), nextSendAt.getTime());
  assert.equal(sendDecision({ now: new Date('2026-10-14T08:00:31Z'), nextSendAt, sentToday: 3, settings: {} }).ok, true);
  assert.equal(sendDecision({ now, nextSendAt: null, sentToday: 0, settings: {} }).ok, true);
});

test('paused sender never sends', () => {
  const d = sendDecision({ now: new Date(), sentToday: 0, settings: {}, pausedAt: new Date() });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'paused');
});

test('daily cap is a rolling 24 hours, not a reset at Nairobi midnight', () => {
  // 23:30 Nairobi on Oct 14 is 20:30 UTC.
  const now = new Date('2026-10-14T20:30:00Z');
  assert.equal(sendDecision({ now, sentToday: 199, settings: {} }).ok, true);
  const capped = sendDecision({ now, sentToday: 200, settings: {} });
  assert.equal(capped.ok, false);
  assert.equal(capped.reason, 'daily_cap');
  // Without a known free up time the safe answer is 24 hours later, never the next midnight.
  assert.equal(capped.retryAt.toISOString(), '2026-10-15T20:30:00.000Z');
  // With the time the oldest counted send turns 24 hours old, that is the retry time.
  const freesAt = new Date('2026-10-15T08:25:52Z');
  assert.equal(sendDecision({ now, sentToday: 200, settings: {}, capResumesAt: freesAt }).retryAt.toISOString(), freesAt.toISOString());
  assert.equal(sendDecision({ now, sentToday: 50, settings: { dailySendCap: 50 } }).reason, 'daily_cap');
  assert.equal(sendWindowStart(now).toISOString(), '2026-10-13T20:30:00.000Z');
});

test('send times read in Nairobi time', () => {
  assert.equal(formatSendTime(new Date('2026-11-24T08:25:52Z')), '24 Nov 11:25 Nairobi time');
});

test('Nairobi day boundary, not UTC', () => {
  // 01:00 Nairobi on Oct 15 is 22:00 UTC on Oct 14: already the new day.
  const now = new Date('2026-10-14T22:00:00Z');
  assert.equal(sendDayStart(now).toISOString(), '2026-10-14T21:00:00.000Z');
  assert.equal(nextSendDayStart(now).toISOString(), '2026-10-15T21:00:00.000Z');
  // 23:59 Nairobi is still the old day.
  const late = new Date('2026-10-14T20:59:00Z');
  assert.equal(sendDayStart(late).toISOString(), '2026-10-13T21:00:00.000Z');
});

test('campaign auto pause rule: over 5% hard bounces after at least 20 sends', async () => {
  const { shouldPauseForBounces } = await import('../src/services/sendScheduler.js');
  assert.equal(shouldPauseForBounces({ attempted: 19, bounced: 10 }), false);
  assert.equal(shouldPauseForBounces({ attempted: 20, bounced: 1 }), false);
  assert.equal(shouldPauseForBounces({ attempted: 20, bounced: 2 }), true);
  assert.equal(shouldPauseForBounces({ attempted: 100, bounced: 5 }), false);
  assert.equal(shouldPauseForBounces({ attempted: 100, bounced: 6 }), true);
});

test('throughput with defaults is about 257 emails per hour', () => {
  assert.equal(averageSendIntervalMs({}), 14_000);
  assert.equal(emailsPerHour({}), 257);
  assert.equal(emailsPerHour({ sendGapSeconds: 30, sendJitterSeconds: 10 }), 98);
});

test('estimated finish: 100 queued at defaults takes about 23 minutes', () => {
  const now = new Date('2026-10-19T07:00:00Z'); // 10:00 Nairobi
  const eta = estimateFinish({ now, queued: 100, sentToday: 0, settings: {} });
  assert.equal(eta.getTime() - now.getTime(), 99 * 14_000);
  assert.equal(estimateFinish({ now, queued: 0, settings: {} }), null);
  // Waits for the next slot first.
  const next = new Date(now.getTime() + 8000);
  assert.equal(estimateFinish({ now, queued: 1, nextSendAt: next, settings: {} }).getTime(), next.getTime());
});

test('estimated finish waits for room in the rolling 24 hour cap', () => {
  const now = new Date('2026-10-19T07:00:00Z'); // 10:00 Nairobi
  // 190 sent in the last 24 hours, cap 200: 10 now, the other 40 once the oldest send ages out.
  const freesAt = new Date('2026-10-19T15:00:00Z');
  const eta = estimateFinish({ now, queued: 50, sentToday: 190, settings: {}, capResumesAt: freesAt });
  assert.equal(eta.toISOString(), new Date(freesAt.getTime() + 39 * 14_000).toISOString());
  // Cap already reached: everything waits for room.
  const eta2 = estimateFinish({ now, queued: 3, sentToday: 200, settings: {}, capResumesAt: freesAt });
  assert.equal(eta2.toISOString(), new Date(freesAt.getTime() + 2 * 14_000).toISOString());
  // Unknown free up time: 24 hours after this batch started, never the next midnight.
  const eta3 = estimateFinish({ now, queued: 3, sentToday: 200, settings: {} });
  assert.equal(eta3.toISOString(), new Date(now.getTime() + 86_400_000 + 2 * 14_000).toISOString());
  // More than two full caps: 450 queued, 0 sent, cap 200 => third batch starts 48 hours later.
  const eta4 = estimateFinish({ now, queued: 450, sentToday: 0, settings: {} });
  assert.equal(eta4.toISOString(), new Date(now.getTime() + 2 * 86_400_000 + 49 * 14_000).toISOString());
});

test('background run budget follows the Vercel deadline with a safety margin', () => {
  const now = Date.now();
  assert.equal(sendRunBudgetMs({ now, deadline: new Date(now + 300_000) }), 270_000);
  assert.equal(sendRunBudgetMs({ now, deadline: new Date(now + 60_000) }), 35_000);
  assert.equal(sendRunBudgetMs({ now, deadline: new Date(now + 10_000) }), 0);
  assert.equal(sendRunBudgetMs({ now, deadline: undefined }), 270_000);
});
