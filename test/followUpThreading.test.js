import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldThreadFollowUp,
  threadingForPreviousSend,
  sendWithThreadFallback,
} from '../src/services/emailService.js';

test('different or unknown sender gives a new thread', () => {
  assert.equal(shouldThreadFollowUp('acct-a', 'acct-b'), false);
  assert.equal(shouldThreadFollowUp(null, 'acct-b'), false);
  assert.equal(shouldThreadFollowUp('acct-a', null), false);
  assert.equal(shouldThreadFollowUp(undefined, 'acct-b'), false);
  assert.equal(shouldThreadFollowUp('acct-a', 'acct-a'), true);

  assert.deepEqual(
    threadingForPreviousSend({ messageId: 'm1', threadId: 't1', senderAccountId: 'acct-a' }, 'acct-b'),
    {},
  );
  assert.deepEqual(
    threadingForPreviousSend({ messageId: 'm1', threadId: 't1', senderAccountId: null }, 'acct-a'),
    {},
  );
  assert.deepEqual(
    threadingForPreviousSend({ messageId: 'm1', threadId: 't1', senderAccountId: 'acct-a' }, 'acct-a'),
    { inReplyTo: 'm1', references: 'm1', threadId: 't1' },
  );
});

test('404 on a threaded send retries once as a new email with the same subject', async () => {
  const calls = [];
  const send = async (payload) => {
    calls.push(payload);
    if (payload.threadId || payload.inReplyTo) {
      const err = new Error('Requested entity was not found.');
      err.code = 404;
      throw err;
    }
    return { messageId: 'm-new', threadId: 't-new', subject: payload.subject };
  };

  const payload = { to: 'a@x.dev', subject: 'Follow up two', html: '<p>Hi</p>', accountId: 'acct-b' };
  const result = await sendWithThreadFallback(send, payload, {
    threadId: 't-old',
    inReplyTo: 'm-old',
    references: 'm-old',
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].threadId, 't-old');
  assert.equal(calls[0].inReplyTo, 'm-old');
  assert.equal(calls[0].subject, 'Follow up two');
  assert.equal(calls[1].threadId, undefined);
  assert.equal(calls[1].inReplyTo, undefined);
  assert.equal(calls[1].references, undefined);
  assert.equal(calls[1].subject, 'Follow up two');
  assert.equal(result.messageId, 'm-new');
});

test('non 404 threaded failures are not retried', async () => {
  const send = async () => {
    const err = new Error('Invalid To header');
    err.code = 400;
    throw err;
  };
  await assert.rejects(
    () => sendWithThreadFallback(send, { subject: 'S' }, { threadId: 't1' }),
    /Invalid To header/,
  );
});
