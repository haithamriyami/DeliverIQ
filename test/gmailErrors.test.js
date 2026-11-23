import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySendError,
  isTransientQuotaError,
  isThreadNotFoundError,
  retryAfterMs,
  backoffMs,
  isQuotaOnlyPauseReason,
  isDailySendingLimitError,
  gmailRetryAt,
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

test('404 and Requested entity was not found are send errors, not bounces', () => {
  assert.equal(classifySendError({ code: 404, message: 'Requested entity was not found.' }), 'send_error');
  assert.equal(classifySendError({
    code: 404,
    message: 'Requested entity was not found.',
    errors: [{ reason: 'notFound', message: 'Requested entity was not found.' }],
  }), 'send_error');
  assert.equal(classifySendError({ status: 404, message: 'Not Found' }), 'send_error');
  assert.equal(isThreadNotFoundError({ code: 404, message: 'Requested entity was not found.' }), true);
  assert.equal(isThreadNotFoundError({ message: 'Requested entity was not found.' }), true);
  assert.equal(isThreadNotFoundError({ code: 400, message: 'Invalid To header' }), false);
});

test('5xx and network failures are send errors, not bounces', () => {
  assert.equal(classifySendError({ code: 500, message: 'Internal error' }), 'send_error');
  assert.equal(classifySendError({ code: 503, message: 'Service unavailable' }), 'send_error');
  assert.equal(classifySendError({ message: 'socket hang up' }), 'send_error');
  assert.equal(classifySendError({ message: 'connect ETIMEDOUT 8.8.8.8:443' }), 'send_error');
});

test('only clear recipient problems are classified as recipient bounces', () => {
  assert.equal(classifySendError({ code: 400, message: 'Invalid To header' }), 'recipient');
  assert.equal(classifySendError({ code: 400, message: 'Invalid recipient' }), 'recipient');
  assert.equal(classifySendError({ message: 'Recipient address rejected: user unknown' }), 'recipient');
  assert.equal(classifySendError({ code: 400, message: 'Something else went wrong' }), 'send_error');
});

// The exact error financebridge.ai@gmail.com got on Nov 24 2026 after 549 sends in 24 hours.
const MAIL_SENDING_MSG = 'User-rate limit exceeded.  Retry after 2026-11-23T21:34:19.807Z (Mail sending)';

test('Gmail daily sending limit is its own kind: a hold, not a pause, a retry loop or a bounce', () => {
  for (const err of [
    { code: 429, message: MAIL_SENDING_MSG },
    { code: 403, message: MAIL_SENDING_MSG, errors: [{ reason: 'rateLimitExceeded', message: MAIL_SENDING_MSG }] },
    { code: 403, message: 'Daily user sending quota exceeded.', errors: [{ reason: 'dailyLimitExceeded' }] },
    { code: 403, message: 'Daily user sending limit exceeded.' },
    { code: 550, message: 'The user has exceeded the maximum number of recipients' },
  ]) {
    assert.equal(isDailySendingLimitError(err), true, err.message);
    assert.equal(isTransientQuotaError(err), false, err.message);
    assert.equal(classifySendError(err), 'daily_limit', err.message);
  }
  // Plain per minute rate limits, without "Mail sending", stay a short backoff.
  assert.equal(classifySendError({ message: 'User-rate limit exceeded' }), 'transient');
  assert.equal(classifySendError({ code: 403, message: 'User Rate Limit Exceeded', errors: [{ reason: 'userRateLimitExceeded' }] }), 'transient');
  // Policy problems are still a real pause.
  assert.equal(classifySendError({ code: 403, message: 'Message rejected for policy reasons. Mail sending' }), 'sender_block');
});

test('Gmail retry time is read from the message text or a Retry-After header', () => {
  assert.equal(gmailRetryAt({ message: MAIL_SENDING_MSG }).toISOString(), '2026-11-23T21:34:19.807Z');
  const now = Date.parse('2026-11-23T21:00:00Z');
  assert.equal(gmailRetryAt({ message: 'x', response: { headers: { 'retry-after': '60' } } }, now).toISOString(), '2026-11-23T21:01:00.000Z');
  assert.equal(gmailRetryAt({ message: 'no time here' }, now), null);
});
