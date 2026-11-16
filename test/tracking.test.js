import test from 'node:test';
import assert from 'node:assert/strict';
import {
  withEngagementTracking,
  withUtm,
  campaignSlug,
  linkifyBareUrls,
  plainTextToHtml,
  looksLikeHtml,
  parseTrackingToken,
} from '../src/utils/tracking.js';
import { renderEmailHtml } from '../src/services/emailService.js';
import { htmlToPlainText, mimeBase64 } from '../src/services/gmailService.js';
import { recordEngagement } from '../src/controllers/trackingController.js';
import { resolveAppUrl, env } from '../src/config/env.js';

const ids = { campaignId: 'camp1', recipientId: 'rec1', stepId: 'step1', campaignName: 'Accountants - United Kingdom' };

function clickTargets(html) {
  return [...html.matchAll(/href="([^"]+)"/g)]
    .map((m) => m[1].replace(/&amp;/g, '&'))
    .filter((href) => href.includes('/t/c/'))
    .map((href) => new URL(href).searchParams.get('u'));
}

test('campaignSlug makes a clean utm_campaign value', () => {
  assert.equal(campaignSlug('Accountants - United Kingdom'), 'accountants-united-kingdom');
  assert.equal(campaignSlug('Salon barbers-UK-01'), 'salon-barbers-uk-01');
  assert.equal(campaignSlug(''), '');
});

test('withUtm adds missing tags and keeps existing ones untouched', () => {
  assert.equal(
    withUtm('https://financebridge.live', 'Bakeries - Kenya'),
    'https://financebridge.live?utm_source=email&utm_medium=email&utm_campaign=bakeries-kenya'
  );
  assert.equal(
    withUtm('https://financebridge.live?utm_source=email&utm_campaign=accountants', 'Accountants - UAE'),
    'https://financebridge.live?utm_source=email&utm_campaign=accountants&utm_medium=email'
  );
  assert.equal(
    withUtm('https://financebridge.live/signup?ref=x#top', 'C'),
    'https://financebridge.live/signup?ref=x&utm_source=email&utm_medium=email&utm_campaign=c#top'
  );
  const full = 'https://a.dev/?utm_source=news&utm_medium=cpc&utm_campaign=spring';
  assert.equal(withUtm(full, 'Other'), full);
  assert.equal(withUtm('not a url', 'C'), 'not a url');
});

test('plain text templates become HTML with line breaks', () => {
  assert.equal(looksLikeHtml('Hi there,\n\nThanks'), false);
  assert.equal(looksLikeHtml('<p>Hi</p>'), true);
  assert.equal(plainTextToHtml('Hi <there> & you\nBye'), 'Hi &lt;there&gt; &amp; you<br>\nBye');
});

test('linkifyBareUrls wraps bare URLs, trims punctuation and skips tags and links', () => {
  const out = linkifyBareUrls('Go to https://financebridge.live. Or (https://x.dev/a) <a href="https://y.dev">https://y.dev</a> <img src="https://z.dev/p.gif">');
  assert.equal(
    out,
    'Go to <a href="https://financebridge.live">https://financebridge.live</a>. Or (<a href="https://x.dev/a">https://x.dev/a</a>) <a href="https://y.dev">https://y.dev</a> <img src="https://z.dev/p.gif">'
  );
});

test('bare URL in a plain text template is tracked with UTM tags', () => {
  const body = 'Hi there,\n\nYour free account: https://financebridge.live?utm_source=email&utm_campaign=accountants\n\nThanks';
  const html = withEngagementTracking(plainTextToHtml(body), ids);
  const targets = clickTargets(html);
  assert.equal(targets.length, 1);
  assert.equal(targets[0], 'https://financebridge.live?utm_source=email&utm_campaign=accountants&utm_medium=email');
  assert.ok(html.includes(`${env.appUrl}/t/c/`), 'click goes through the tracker');
  assert.ok(html.includes('>https://financebridge.live?utm_source=email&amp;utm_campaign=accountants</a>'), 'reader still sees the original link');
  assert.equal((html.match(/\/t\/o\//g) || []).length, 1, 'one open pixel');

  const token = html.match(/\/t\/c\/([^?"]+)/)[1];
  assert.deepEqual(parseTrackingToken(token), { campaignId: 'camp1', recipientId: 'rec1', stepId: 'step1' });
});

test('existing hrefs are tracked once and unsubscribe links are never tracked', () => {
  const unsubscribeUrl = `${env.appUrl}/unsubscribe.html?token=abc`;
  const html = withEngagementTracking(
    `<p>See <a href="https://financebridge.live">our site</a></p><p><a href="${unsubscribeUrl}">Unsubscribe</a></p>`,
    { ...ids, unsubscribeUrl }
  );
  assert.deepEqual(clickTargets(html), ['https://financebridge.live?utm_source=email&utm_medium=email&utm_campaign=accountants-united-kingdom']);
  assert.ok(html.includes(`href="${unsubscribeUrl}"`));

  const again = withEngagementTracking(html, { ...ids, unsubscribeUrl });
  assert.equal(again, html, 'running twice does not double wrap');
});

test('test sends get links and UTM tags but no tracking', () => {
  const html = withEngagementTracking('Visit https://financebridge.live', { ...ids, recipientId: 'test' });
  assert.equal(
    html,
    'Visit <a href="https://financebridge.live?utm_source=email&amp;utm_medium=email&amp;utm_campaign=accountants-united-kingdom">https://financebridge.live</a>'
  );
});

test('renderEmailHtml keeps line breaks and plain text part uses the tracked link', () => {
  const unsubscribeUrl = `${env.appUrl}/unsubscribe.html?token=abc`;
  const html = renderEmailHtml({
    html: 'Hi {{name}},\n\nTry it: https://financebridge.live\n\nThanks,\nHaitham',
    name: 'Amina',
    to: 'a@x.dev',
    unsubscribeUrl,
    ...ids,
  });
  assert.ok(html.startsWith('Hi Amina,<br>\n<br>\nTry it: <a href="'));
  assert.equal(clickTargets(html).length, 1);

  const text = htmlToPlainText(html);
  assert.ok(text.startsWith('Hi Amina,\n\nTry it: '), text);
  const link = text.match(/Try it: (\S+)/)[1];
  assert.ok(link.startsWith(`${env.appUrl}/t/c/`), 'plain text link is tracked');
  assert.equal(
    new URL(link).searchParams.get('u'),
    'https://financebridge.live?utm_source=email&utm_medium=email&utm_campaign=accountants-united-kingdom'
  );
  assert.ok(text.includes(`Unsubscribe (${unsubscribeUrl})`));
});

test('mimeBase64 round trips and wraps lines', () => {
  const html = '<a href="https://f.live?utm_campaign=accountants">Don’t</a>'.repeat(5);
  const encoded = mimeBase64(html);
  assert.ok(encoded.split('\r\n').every((line) => line.length <= 76));
  assert.equal(Buffer.from(encoded.replace(/\r\n/g, ''), 'base64').toString('utf8'), html);
});

test('recordEngagement waits for the write before answering', async () => {
  const calls = [];
  let done = false;
  const apply = async (args) => {
    calls.push(args);
    await new Promise((r) => setTimeout(r, 30));
    done = true;
  };
  const outcome = await recordEngagement({ campaignId: 'c', recipientId: 'r', stepId: 's' }, 'open', { apply });
  assert.equal(outcome, 'saved');
  assert.equal(done, true, 'write finished before the response');
  assert.deepEqual(calls, [{ campaignId: 'c', recipientId: 'r', stepId: 's', event: 'open' }]);
});

test('recordEngagement never throws and gives up waiting after the timeout', async () => {
  const failed = await recordEngagement({ campaignId: 'c', recipientId: 'r' }, 'click', {
    apply: async () => {
      throw new Error('db down');
    },
  });
  assert.equal(failed, 'failed');

  const slow = await recordEngagement({ campaignId: 'c', recipientId: 'r' }, 'click', {
    apply: () => new Promise((r) => setTimeout(r, 200)),
    timeoutMs: 20,
  });
  assert.equal(slow, 'timeout');
  assert.equal(await recordEngagement(null, 'open'), 'skipped');
});

test('resolveAppUrl prefers APP_URL then Vercel domains', () => {
  assert.equal(resolveAppUrl({ APP_URL: 'https://deliveriq-eosin.vercel.app/' }), 'https://deliveriq-eosin.vercel.app');
  assert.equal(
    resolveAppUrl({ VERCEL_PROJECT_PRODUCTION_URL: 'deliveriq-eosin.vercel.app', VERCEL_URL: 'deliveriq-abc.vercel.app' }),
    'https://deliveriq-eosin.vercel.app'
  );
  assert.equal(resolveAppUrl({ VERCEL_URL: 'deliveriq-abc.vercel.app' }), 'https://deliveriq-abc.vercel.app');
  assert.equal(resolveAppUrl({ PORT: '4000' }), 'http://127.0.0.1:4000');
});
