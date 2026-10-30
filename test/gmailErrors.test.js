import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySendError,
  isTransientQuotaError,
  retryAfterMs,
  backoffMs,
  isQuotaOnlyPauseReason,
} from '../src/utils/sendErrors.js';

const QUOTA_MSG =
  "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user' of service 'gmail.googleapis.com' for consumer 'project_number:694163727805'.";

test('per minute read quota is transient, never a pause', () => {
  for (const err of [
    { code: 429, message: QUOTA_MSG },
    { code: 403, message: QUOTA_MSG, errors: [{ reason: 'rateLimitExceeded' }] },
    { code: 403, message: 'User Rate Limit Exceeded', errors: [{ reason: 'userRateLimitExceeded' }] },
    { code: 429, message: 'Too many concurrent requests for user' },
  ]) {
    assert.equal(isTransientQuotaError(err), true, err.message);
    assert.equal(classifySendError(err), 'transient', err.message);
  }
});

test('real sending problems still pause', () => {
  assert.equal(classifySendError({ code: 403, message: 'Daily user sending quota exceeded.', errors: [{ reason: 'dailyLimitExceeded' }] }), 'sender_block');
  assert.equal(classifySendError({ code: 400, message: 'Mail service not enabled: account suspended' }), 'sender_block');
  assert.equal(classifySendError({ code: 403, message: 'Message rejected for policy reasons' }), 'sender_block');
  assert.equal(classifySendError({ code: 400, message: 'invalid_grant' }), 'auth');
  assert.equal(classifySendError({ code: 403, message: 'Insufficient Permission' }), 'auth');
  assert.equal(classifySendError({ code: 400, message: 'Invalid To header' }), 'recipient');
  assert.equal(isTransientQuotaError({ code: 403, message: 'Daily user sending quota exceeded.' }), false);
});

test('Retry-After header and exponential backoff', () => {
  assert.equal(retryAfterMs({ response: { headers: { 'retry-after': '120' } } }), 120000);
  const now = Date.parse('2026-10-30T09:00:00Z');
  assert.equal(retryAfterMs({ response: { headers: { 'retry-after': 'Fri, 30 Oct 2026 09:01:30 GMT' } } }, now), 90000);
  assert.equal(retryAfterMs({}), null);
  assert.equal(backoffMs(1), 60000);
  assert.equal(backoffMs(2), 120000);
  assert.equal(backoffMs(3), 240000);
  assert.equal(backoffMs(20), 30 * 60000, 'capped');
  assert.equal(backoffMs(1, { retryAfter: 300000 }), 300000, 'Retry-After wins when longer');
});

test('auto resume only for quota pauses', () => {
  const oldPause = `Gmail returned a rate limit, policy or account restriction error, so all sending from this account is paused. Check the Gmail account, then press Resume. Gmail said: ${QUOTA_MSG}`;
  assert.equal(isQuotaOnlyPauseReason(oldPause), true);
  assert.equal(isQuotaOnlyPauseReason('Gmail returned a rate limit, policy or account restriction error ... Gmail said: Mail service not enabled: account suspended'), false);
  assert.equal(isQuotaOnlyPauseReason('Gmail refused the send because access needs to be reconnected.'), false);
  assert.equal(isQuotaOnlyPauseReason(''), false);
});
