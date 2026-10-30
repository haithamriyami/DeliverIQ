import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyReply, stripQuoted } from '../src/utils/replyClassifier.js';
import { classifySendError } from '../src/utils/sendErrors.js';

test('auto replies by subject', () => {
  for (const subject of ['Automatic Reply: Quick question', 'OOO until Monday', 'Out of Office', 'Re: Hello [Out of office]', 'Auto-reply: hi', 'Autoreply']) {
    assert.equal(classifyReply({ subject, body: 'Thanks' }), 'auto_reply', subject);
  }
});

test('auto replies by header', () => {
  assert.equal(classifyReply({ subject: 'Re: Hello', body: 'Hi', headers: [{ name: 'Auto-Submitted', value: 'auto-replied' }] }), 'auto_reply');
  assert.equal(classifyReply({ subject: 'Re: Hello', body: 'Hi', headers: { 'X-Autoreply': 'yes' } }), 'auto_reply');
  assert.equal(classifyReply({ subject: 'Re: Hello', body: 'Sounds good', headers: { 'Auto-Submitted': 'no' } }), 'reply');
});

test('auto replies by body', () => {
  assert.equal(classifyReply({ subject: 'Re: Hello', body: 'I am currently out of the office and will respond when I return.' }), 'auto_reply');
});

test('auto reply that mentions stop or unsubscribe is still an auto reply', () => {
  assert.equal(classifyReply({ subject: 'Out of office', body: 'To unsubscribe from our newsletter click here. Please stop by our booth.' }), 'auto_reply');
});

test('clear opt outs', () => {
  for (const body of ['Not interested, thanks.', 'Please remove me from your list', 'unsubscribe', 'STOP', 'Stop.', 'Please stop emailing me', 'Take me off this list', 'Do not contact me again']) {
    assert.equal(classifyReply({ subject: 'Re: Quick question', body }), 'opt_out', body);
  }
  assert.equal(classifyReply({ subject: 'Unsubscribe', body: '' }), 'opt_out');
});

test('human replies', () => {
  for (const body of ['Sounds interesting, can we talk Thursday?', 'Who is this?', 'Send me pricing', "Don't stop believing, call me"]) {
    assert.equal(classifyReply({ subject: 'Re: Quick question', body }), 'reply', body);
  }
});

test('quoted original email with our unsubscribe footer does not count as an opt out', () => {
  const body = [
    'Yes, I would like to learn more.',
    '',
    'On Tue, Oct 13, 2026 at 10:00 AM Haitham <financebridge.ai@gmail.com> wrote:',
    '> Hi there',
    '> Don\u2019t want these emails? Unsubscribe',
  ].join('\n');
  assert.equal(classifyReply({ subject: 'Re: Quick question', body }), 'reply');
  assert.equal(stripQuoted(body), 'Yes, I would like to learn more.');
});

test('send error classification', () => {
  assert.equal(classifySendError({ code: 429, message: 'Too many requests' }), 'transient');
  assert.equal(classifySendError({ message: 'User-rate limit exceeded' }), 'transient');
  assert.equal(classifySendError({ code: 400, message: 'Mail service not enabled: account suspended' }), 'sender_block');
  assert.equal(classifySendError({ code: 403, message: 'Message rejected for policy reasons' }), 'sender_block');
  assert.equal(classifySendError({ message: 'invalid_grant' }), 'auth');
  assert.equal(classifySendError({ code: 400, message: 'Invalid To header' }), 'recipient');
});
