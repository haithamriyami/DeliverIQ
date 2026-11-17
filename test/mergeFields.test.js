import test from 'node:test';
import assert from 'node:assert/strict';
import {
  interpolate,
  mergeFieldValues,
  renderMergePreview,
  NAME_FALLBACK,
  ORGANIZATION_FALLBACK,
} from '../src/services/emailService.js';

test('fills name, organization and the company alias', () => {
  const vars = mergeFieldValues({
    name: 'Louise Cottar',
    email: 'louise@cottarsafaris.com',
    organization: "Cottar's Safaris",
  });
  assert.equal(vars.name, 'Louise Cottar');
  assert.equal(vars.organization, "Cottar's Safaris");
  assert.equal(vars.company, "Cottar's Safaris");
  const body = interpolate(
    'Hi {{name}},\n\nI am offering a free 2 week pilot for {{organization}}.',
    vars
  );
  assert.equal(body, "Hi Louise Cottar,\n\nI am offering a free 2 week pilot for Cottar's Safaris.");
  const subject = interpolate('A pilot for {{company}}', { organization: "Cottar's Safaris" });
  assert.equal(subject, "A pilot for Cottar's Safaris");
});

test('uses fallbacks when name or organization is missing, and leaves no raw placeholders', () => {
  const out = interpolate(
    'Hi {{ name }}, a pilot for {{organization}} and {{company}}.',
    { name: '  ', organization: '', email: 'a@b.test' }
  );
  assert.equal(
    out,
    `Hi ${NAME_FALLBACK}, a pilot for ${ORGANIZATION_FALLBACK} and ${ORGANIZATION_FALLBACK}.`
  );
  assert.equal(out.includes('{{'), false);
});

test('renderMergePreview fills a real subject and body', () => {
  const preview = renderMergePreview({
    subject: 'A pilot for {{organization}}',
    body: 'Hi {{first_name}}, I am offering a free 2 week pilot for {{organization}}.',
    name: 'Stathis Sotiriou',
    organization: 'University of Nicosia',
    email: 'sotiriou.s@unic.ac.cy',
  });
  assert.equal(preview.subject, 'A pilot for University of Nicosia');
  assert.equal(preview.body, 'Hi Stathis Sotiriou, I am offering a free 2 week pilot for University of Nicosia.');
  assert.equal(preview.body.includes('{{'), false);
});
