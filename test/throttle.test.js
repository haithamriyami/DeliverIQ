import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeNextSendAt,
  sendDecision,
  sendDayStart,
  nextSendDayStart,
  normalizeSendSettings,
  DEFAULT_SEND_SETTINGS,
} from '../src/utils/throttle.js';

test('defaults are 30 s gap, 10 s jitter, 200 per day', () => {
  assert.deepEqual(normalizeSendSettings({}), { sendGapSeconds: 30, sendJitterSeconds: 10, dailySendCap: 200 });
  assert.deepEqual(normalizeSendSettings(null), { ...DEFAULT_SEND_SETTINGS });
});

test('gap can never be configured below 30 seconds', () => {
  assert.equal(normalizeSendSettings({ sendGapSeconds: 5 }).sendGapSeconds, 30);
  assert.equal(normalizeSendSettings({ sendGapSeconds: 45 }).sendGapSeconds, 45);
});

test('next send is 30 to 40 seconds after a send', () => {
  const t = new Date('2026-10-14T08:00:00Z');
  const min = computeNextSendAt(t, DEFAULT_SEND_SETTINGS, () => 0);
  const max = computeNextSendAt(t, DEFAULT_SEND_SETTINGS, () => 0.999999);
  assert.equal(min.getTime() - t.getTime(), 30_000);
  assert.ok(max.getTime() - t.getTime() < 40_000);
  assert.ok(max.getTime() - t.getTime() >= 39_000);
  for (let i = 0; i < 200; i += 1) {
    const gap = computeNextSendAt(t, DEFAULT_SEND_SETTINGS).getTime() - t.getTime();
    assert.ok(gap >= 30_000 && gap <= 40_000, `gap ${gap}`);
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

test('daily cap of 200 holds the rest until Nairobi midnight', () => {
  // 23:30 Nairobi on Oct 14 is 20:30 UTC.
  const now = new Date('2026-10-14T20:30:00Z');
  assert.equal(sendDecision({ now, sentToday: 199, settings: {} }).ok, true);
  const capped = sendDecision({ now, sentToday: 200, settings: {} });
  assert.equal(capped.ok, false);
  assert.equal(capped.reason, 'daily_cap');
  assert.equal(capped.retryAt.toISOString(), '2026-10-14T21:00:00.000Z');
  assert.equal(sendDecision({ now, sentToday: 50, settings: { dailySendCap: 50 } }).reason, 'daily_cap');
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
