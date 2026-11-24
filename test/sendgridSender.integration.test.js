// Runs only against a throwaway database: TEST_DATABASE_URL=postgresql://... npm test
// Never point this at production. It deletes all rows in the tables it uses.
// SendGrid is always a fake client here: nothing is ever sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const url = process.env.TEST_DATABASE_URL;
// A fake key so the code treats SendGrid as configured. The fake client below is what "sends".
process.env.SENDGRID_API_KEY = 'SG.fake-key-for-tests';
process.env.SENDGRID_FROM_EMAIL = 'hello@financebridge.live';
process.env.SENDGRID_FROM_NAME = 'Finance Bridge';
delete process.env.SENDGRID_WEBHOOK_VERIFICATION_KEY;

function fakeSendGrid() {
  const sent = [];
  let n = 0;
  let failWith = null;
  return {
    sent,
    failNext(err) { failWith = err; },
    async send(message) {
      if (failWith) { const err = failWith; failWith = null; throw err; }
      n += 1;
      sent.push(message);
      return [{ statusCode: 202, headers: { 'x-message-id': `sgmsg${n}` } }];
    },
  };
}

async function setup({ people: count = 6, gmailCap = 100 } = {}) {
  process.env.DATABASE_URL = url;
  const { prisma } = await import('../src/lib/prisma.js');
  const scheduler = await import('../src/services/sendScheduler.js');
  const campaignService = await import('../src/services/campaignService.js');
  const sendgrid = await import('../src/services/sendgridService.js');
  const emailService = await import('../src/services/emailService.js');
  const { linkGmail } = await import('./helpers/gmail.js');
  const hooks = {
    recordSend: campaignService.recordSend,
    recordBounce: campaignService.recordBounce,
    maybeCompleteCampaign: campaignService.maybeCompleteCampaign,
  };
  for (const table of ['inboundReply', 'campaignRecipient', 'campaignStep', 'campaign', 'recipient', 'contactList', 'template', 'user', 'gmailAccount', 'workspace']) {
    await prisma[table].deleteMany({});
  }
  await prisma.schedulerLease.deleteMany({ where: { name: { startsWith: 'claim:' } } });
  const ws = await prisma.workspace.create({ data: { name: 'Finance Bridge', dailySendCap: gmailCap, replyToEmail: 'financebridge.ai@gmail.com' } });
  const user = await prisma.user.create({ data: { email: 'h@t.dev', name: 'Haitham', passwordHash: 'x', role: 'owner', workspaceId: ws.id } });
  await prisma.workspaceMember.create({ data: { workspaceId: ws.id, userId: user.id, role: 'owner' } });
  const gmail = await linkGmail({ userId: user.id, workspaceId: ws.id, email: 'financebridge.ai@gmail.com' });
  const list = await prisma.contactList.create({ data: { workspaceId: ws.id, name: 'L' } });
  const tpl = await prisma.template.create({ data: { workspaceId: ws.id, name: 'T', body: '<p>Hi {{name}}</p>' } });
  const people = [];
  for (let i = 0; i < count; i += 1) {
    people.push(await prisma.recipient.create({ data: { workspaceId: ws.id, email: `p${i}@x.dev`, name: `P${i}`, listId: list.id } }));
  }
  const campaign = await campaignService.createCampaign({
    workspaceId: ws.id, name: 'C', subject: 'Hello {{name}}', templateId: tpl.id, scheduledAt: new Date(),
    recipientIds: people.map((p) => p.id), listId: list.id, createdById: user.id,
  });
  await prisma.campaignStep.updateMany({ where: { campaignId: campaign.id }, data: { status: 'sending' } });
  const step = (await prisma.campaignStep.findMany({ where: { campaignId: campaign.id } }))[0];
  const sg = fakeSendGrid();
  sendgrid.setSendGridClient(sg);
  const gmailSends = [];
  // Gmail is faked; SendGrid goes through the real code path into the fake client.
  const send = async (payload) => {
    if (payload.provider === 'sendgrid') return emailService.sendCampaignEmail(payload);
    gmailSends.push(payload);
    return { messageId: `g${gmailSends.length}`, threadId: `gt${gmailSends.length}` };
  };
  const row = (id) => prisma.gmailAccount.findUnique({ where: { id } });
  return { prisma, scheduler, campaignService, sendgrid, emailService, hooks, ws, user, gmail, people, campaign, step, sg, send, gmailSends, row };
}

const opts = { skip: !url && 'TEST_DATABASE_URL not set' };

test('SendGrid is off by default: only Gmail sends and SendGrid is never called', opts, async () => {
  const { prisma, scheduler, sendgrid, ws, gmail, sg, send, hooks, row } = await setup();
  assert.deepEqual(await sendgrid.sendGridWorkspaceIds(), []);
  const senders = await scheduler.activeSenders();
  assert.deepEqual(senders.map((s) => s.email), ['financebridge.ai@gmail.com']);
  const r = await scheduler.sendOneForSender(await row(gmail.id), null, { now: new Date(), send, hooks });
  assert.equal(r.sent, true);
  assert.equal(sg.sent.length, 0);
  // Saved but switched off: still nothing.
  await sendgrid.saveSendGridSettings(ws.id, { enabled: false, fromEmail: 'hello@financebridge.live' });
  assert.deepEqual(await sendgrid.sendGridWorkspaceIds(), []);
  const sgRow = await sendgrid.findSendGridAccount();
  const r2 = await scheduler.sendOneForSender(sgRow, null, { now: new Date(), send, hooks });
  assert.equal(r2.sent, false);
  assert.equal(sg.sent.length, 0);
  const status = await scheduler.sendingStatus(ws.id);
  assert.equal(status.senders.length, 1);
  await prisma.$disconnect();
});

test('Gmail and SendGrid share the queue, each within its own rolling cap, and every row records its sender', opts, async () => {
  const { prisma, scheduler, sendgrid, ws, gmail, people, step, sg, send, gmailSends, hooks, row } = await setup({ people: 6 });
  await sendgrid.saveSendGridSettings(ws.id, {
    enabled: true, dailyCap: 2, fromEmail: 'hello@financebridge.live', fromName: 'Finance Bridge', replyToEmail: 'financebridge.ai@gmail.com',
  });
  const sgAcct = await sendgrid.findSendGridAccount();
  assert.deepEqual((await scheduler.activeSenders()).map((s) => s.email).sort(), ['financebridge.ai@gmail.com', 'sendgrid']);

  let now = new Date();
  for (let i = 0; i < 6; i += 1) {
    now = new Date(now.getTime() + 60000);
    await scheduler.sendOneForSender(await row(gmail.id), null, { now, send, hooks });
    await scheduler.sendOneForSender(await row(sgAcct.id), null, { now, send, hooks });
  }
  const rows = await prisma.campaignRecipient.findMany({ where: { stepId: step.id } });
  assert.equal(rows.length, 6, 'everyone got exactly one email');
  assert.equal(new Set(rows.map((r) => r.recipientId)).size, 6);
  const viaSg = rows.filter((r) => r.senderAccountId === sgAcct.id);
  const viaGmail = rows.filter((r) => r.senderAccountId === gmail.id);
  assert.equal(viaSg.length, 2, 'SendGrid stopped at its own cap of 2');
  assert.equal(viaGmail.length, 4);
  assert.equal(sg.sent.length, 2);
  assert.equal(gmailSends.length, 4);
  assert.deepEqual(viaSg.map((r) => r.messageId).sort(), ['sgmsg1', 'sgmsg2']);

  const message = sg.sent[0];
  assert.deepEqual(message.from, { email: 'hello@financebridge.live', name: 'Finance Bridge' });
  assert.equal(message.replyTo, 'financebridge.ai@gmail.com');
  const person = people.find((p) => p.email === message.to);
  assert.ok(person);
  assert.equal(message.subject, `Hello ${person.name}`);
  assert.deepEqual(message.customArgs, { campaignId: step.campaignId, recipientId: person.id, stepId: step.id, senderAccountId: sgAcct.id });
  assert.equal(message.trackingSettings.clickTracking.enable, false);
  assert.equal(message.trackingSettings.openTracking.enable, false);
  assert.equal(message.trackingSettings.subscriptionTracking.enable, false);
  assert.match(message.headers['List-Unsubscribe'], /unsubscribe/);
  assert.match(message.html, /\/t\/o\//, 'DeliverIQ open tracking is in the HTML');

  // Over its cap SendGrid reports daily_cap, Gmail is unaffected.
  const capped = await scheduler.sendOneForSender(await row(sgAcct.id), null, { now: new Date(now.getTime() + 60000), send, hooks });
  assert.ok(['daily_cap', 'idle'].includes(capped.reason));

  const status = await scheduler.sendingStatus(ws.id);
  const sgStatus = status.senders.find((s) => s.provider === 'sendgrid');
  assert.equal(sgStatus.email, 'hello@financebridge.live');
  assert.equal(sgStatus.dailyCap, 2);
  assert.equal(sgStatus.sentToday, 2);
  assert.equal(sgStatus.capReached, true);
  const gStatus = status.senders.find((s) => s.provider === 'gmail');
  assert.equal(gStatus.sentToday, 4, 'SendGrid sends do not count against the Gmail cap');
  await prisma.$disconnect();
});

test('a contact claimed by one sender is never picked by the other at the same moment', opts, async () => {
  const { prisma, scheduler, sendgrid, ws, gmail, people, step } = await setup({ people: 2 });
  await sendgrid.saveSendGridSettings(ws.id, { enabled: true, fromEmail: 'hello@financebridge.live' });
  const sgAcct = await sendgrid.findSendGridAccount();
  const first = await scheduler.nextPendingForSender(sgAcct);
  assert.equal(first.recipient.id, people[0].id);
  assert.equal(await scheduler.claimRecipient(step.id, people[0].id, gmail.id), true);
  assert.equal(await scheduler.claimRecipient(step.id, people[0].id, sgAcct.id), false, 'second claim loses');
  const other = await scheduler.nextPendingForSender(sgAcct);
  assert.equal(other.recipient.id, people[1].id);
  await scheduler.releaseRecipientClaim(step.id, people[0].id, gmail.id);
  assert.equal((await scheduler.nextPendingForSender(sgAcct)).recipient.id, people[0].id);
  // An expired claim can be taken over.
  assert.equal(await scheduler.claimRecipient(step.id, people[1].id, gmail.id, new Date(Date.now() - 10 * 60000)), true);
  assert.equal(await scheduler.claimRecipient(step.id, people[1].id, sgAcct.id), true);
  await prisma.$disconnect();
});

test('follow ups thread only on the same Gmail; after SendGrid they go as a new email, and SendGrid never threads', opts, async () => {
  const { prisma, campaignService, sendgrid, emailService, ws, gmail, people, campaign, step, sg } = await setup({ people: 1 });
  await sendgrid.saveSendGridSettings(ws.id, { enabled: true, fromEmail: 'hello@financebridge.live' });
  const sgAcct = await sendgrid.findSendGridAccount();
  await campaignService.recordSend({ campaignId: campaign.id, recipientId: people[0].id, stepId: step.id, messageId: 'sgmsg-email1', senderAccountId: sgAcct.id });
  const tpl = await prisma.template.findFirst({ where: { workspaceId: ws.id } });
  const follow = await prisma.campaignStep.create({ data: { campaignId: campaign.id, stepNumber: 2, name: 'Follow-up 2', subject: 'Again', templateId: tpl.id, status: 'sending' } });

  const gmailCalls = [];
  const fakeGmail = async (payload) => { gmailCalls.push(payload); return { messageId: 'g-f', threadId: 'gt-f' }; };
  const base = { to: people[0].email, name: 'P0', subject: 'Again', html: '<p>x</p>', campaignId: campaign.id, recipientId: people[0].id, stepId: follow.id, workspaceId: ws.id };
  await emailService.sendCampaignEmail({ ...base, accountId: gmail.id, send: fakeGmail });
  assert.equal(gmailCalls[0].threadId, undefined, 'Email 1 came from SendGrid, so Gmail sends a new email');
  assert.equal(gmailCalls[0].inReplyTo, undefined);

  // SendGrid follow up after a SendGrid Email 1: still a new email, no thread headers.
  await emailService.sendCampaignEmail({ ...base, accountId: sgAcct.id, provider: 'sendgrid' });
  const msg = sg.sent.at(-1);
  assert.equal(msg.headers?.['In-Reply-To'], undefined);
  assert.equal(msg.headers?.References, undefined);

  // Control: when Email 1 went out from this same Gmail, the follow up still threads.
  await prisma.campaignRecipient.updateMany({ where: { stepId: step.id }, data: { senderAccountId: gmail.id, messageId: 'g-email1', threadId: 'gt-email1' } });
  await emailService.sendCampaignEmail({ ...base, accountId: gmail.id, send: fakeGmail });
  assert.equal(gmailCalls.at(-1).threadId, 'gt-email1');
  assert.equal(gmailCalls.at(-1).inReplyTo, 'g-email1');
  await prisma.$disconnect();
});

test('SendGrid errors: credits used up is a hold (not a bounce), a bad key pauses SendGrid only, an invalid address is a bounce', opts, async () => {
  const { prisma, scheduler, sendgrid, ws, gmail, people, step, sg, send, hooks, row } = await setup({ people: 3 });
  await sendgrid.saveSendGridSettings(ws.id, { enabled: true, fromEmail: 'hello@financebridge.live' });
  const sgAcct = await sendgrid.findSendGridAccount();

  sg.failNext(Object.assign(new Error('Maximum credits exceeded'), { code: 401 }));
  const held = await scheduler.sendOneForSender(await row(sgAcct.id), null, { now: new Date(), send, hooks });
  assert.equal(held.reason, 'daily_limit');
  const heldRow = await row(sgAcct.id);
  assert.equal(heldRow.sendingPausedAt, null);
  assert.match(heldRow.sendingPausedReason, /^SendGrid daily sending limit reached/);
  assert.ok(scheduler.dailyLimitHold(heldRow));
  assert.equal(await prisma.campaignRecipient.count({ where: { stepId: step.id } }), 0);

  await prisma.gmailAccount.update({ where: { id: sgAcct.id }, data: { nextSendAt: null, sendingPausedReason: '' } });
  sg.failNext(Object.assign(new Error('Unauthorized'), { code: 401, response: { body: { errors: [{ message: 'The provided authorization grant is invalid, expired, or revoked' }] } } }));
  const paused = await scheduler.sendOneForSender(await row(sgAcct.id), null, { now: new Date(), send, hooks });
  assert.equal(paused.reason, 'sender_paused');
  assert.ok((await row(sgAcct.id)).sendingPausedAt);
  assert.match((await row(sgAcct.id)).sendingPausedReason, /SendGrid refused the send/);
  assert.equal((await row(gmail.id)).sendingPausedAt, null, 'Gmail keeps sending');
  assert.equal((await scheduler.activeSenders()).some((s) => s.id === sgAcct.id), false);

  await scheduler.resumeSender(sgAcct.id);
  await prisma.gmailAccount.update({ where: { id: sgAcct.id }, data: { nextSendAt: null } });
  sg.failNext(Object.assign(new Error('Bad Request'), { code: 400, response: { body: { errors: [{ field: 'personalizations.0.to.0.email', message: 'Does not contain a valid address.' }] } } }));
  const bounced = await scheduler.sendOneForSender(await row(sgAcct.id), null, { now: new Date(), send, hooks });
  assert.equal(bounced.reason, 'bounced');
  const target = await prisma.recipient.findUnique({ where: { id: people[0].id } });
  assert.equal(target.status, 'bounced');
  await prisma.$disconnect();
});

test('classifySendGridError and sendGridReady', async () => {
  const { classifySendGridError, sendGridReady } = await import('../src/services/sendgridService.js');
  assert.equal(classifySendGridError({ code: 429, message: 'Too Many Requests' }), 'transient');
  assert.equal(classifySendGridError({ code: 503, message: 'Service Unavailable' }), 'transient');
  assert.equal(classifySendGridError({ code: 403, message: 'Forbidden', response: { body: { errors: [{ message: 'The from address does not match a verified Sender Identity.' }] } } }), 'auth');
  assert.equal(classifySendGridError({ code: 401, message: 'Maximum credits exceeded' }), 'daily_limit');
  assert.equal(classifySendGridError({ code: 400, message: 'Bad Request', response: { body: { errors: [{ field: 'personalizations.0.to.0.email', message: 'Does not contain a valid address.' }] } } }), 'recipient');
  assert.equal(classifySendGridError({ code: 400, message: 'Bad Request', response: { body: { errors: [{ field: 'content', message: 'too large' }] } } }), 'send_error');
  assert.equal(sendGridReady({ enabled: true, keyConfigured: true, fromEmail: 'a@b.co' }), true);
  assert.equal(sendGridReady({ enabled: false, keyConfigured: true, fromEmail: 'a@b.co' }), false);
  assert.equal(sendGridReady({ enabled: true, keyConfigured: false, fromEmail: 'a@b.co' }), false);
  assert.equal(sendGridReady({ enabled: true, keyConfigured: true, fromEmail: '' }), false);
});

test('signed Event Webhook: a valid ECDSA signature passes, a changed body or old timestamp fails', async () => {
  const crypto = await import('node:crypto');
  const { verifySendGridSignature } = await import('../src/controllers/webhooksController.js');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const key = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const body = Buffer.from(JSON.stringify([{ event: 'bounce', email: 'a@b.co' }]));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createSign('sha256').update(timestamp).update(body).sign(privateKey).toString('base64');
  assert.equal(verifySendGridSignature({ rawBody: body, signature, timestamp, key }), true);
  assert.equal(verifySendGridSignature({ rawBody: Buffer.from(`${body} `), signature, timestamp, key }), false);
  assert.equal(verifySendGridSignature({ rawBody: body, signature, timestamp: String(Number(timestamp) - 2 * 86400), key }), false);
  assert.equal(verifySendGridSignature({ rawBody: body, signature: undefined, timestamp, key }), false);
});

function post(server, path, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      { host: '127.0.0.1', port: server.address().port, method: 'POST', path, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      async (res) => {
        const chunks = [];
        for await (const c of res) chunks.push(c);
        resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

test('Event Webhook marks SendGrid bounces and unsubscribes like Gmail ones, and ignores events it cannot match', opts, async () => {
  const { prisma, scheduler, sendgrid, ws, people, step, send, hooks, row } = await setup({ people: 4 });
  await sendgrid.saveSendGridSettings(ws.id, { enabled: true, fromEmail: 'hello@financebridge.live' });
  const sgAcct = await sendgrid.findSendGridAccount();
  let now = new Date();
  for (let i = 0; i < 4; i += 1) {
    now = new Date(now.getTime() + 60000);
    const r = await scheduler.sendOneForSender(await row(sgAcct.id), null, { now, send, hooks });
    assert.equal(r.sent, true);
  }
  const sends = await prisma.campaignRecipient.findMany({ where: { stepId: step.id }, include: { recipient: true }, orderBy: { messageId: 'asc' } });
  const ev = (i, extra) => ({
    email: sends[i].recipient.email,
    sg_message_id: `${sends[i].messageId}.filterdrecv-1-1`,
    campaignId: sends[i].campaignId, recipientId: sends[i].recipientId, stepId: sends[i].stepId,
    ...extra,
  });
  const { createApp } = await import('../src/app.js');
  const server = createApp().listen(0);
  try {
    const res = await post(server, '/webhooks/sendgrid', [
      ev(0, { event: 'bounce', type: 'bounce', reason: '550 5.1.1 user unknown' }),
      ev(1, { event: 'unsubscribe' }),
      ev(2, { event: 'spamreport' }),
      ev(3, { event: 'bounce', type: 'blocked', reason: '421 try later' }),
      // Forged: right ids, wrong message id. Ignored without a verification key.
      { ...ev(3, { event: 'bounce', type: 'bounce' }), sg_message_id: 'made-up.filter' },
      { event: 'open', ...ev(3) },
      { event: 'bounce', email: 'nobody@x.dev' },
    ]);
    assert.equal(res.status, 200);
    assert.equal(res.json.received, 7);
    assert.equal(res.json.bounced, 1);
    assert.equal(res.json.unsubscribed, 2);
    assert.equal(res.json.noted, 1);
    assert.equal(res.json.ignored, 3);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  const get = (i) => prisma.recipient.findUnique({ where: { id: sends[i].recipientId } });
  const r0 = await get(0);
  assert.equal(r0.status, 'bounced');
  assert.match(r0.lastError, /user unknown/);
  const row0 = await prisma.campaignRecipient.findUnique({ where: { id: sends[0].id } });
  assert.equal(row0.status, 'bounced', 'counted as a bounce for the campaign');
  assert.equal((await get(1)).status, 'unsubscribed');
  const r2 = await get(2);
  assert.equal(r2.status, 'unsubscribed');
  assert.equal(r2.doNotContact, true);
  const r3 = await get(3);
  assert.equal(r3.status, 'active', 'a temporary block is not a bounce');
  assert.match(r3.lastError, /421/);
  assert.equal((await prisma.campaignRecipient.findUnique({ where: { id: sends[3].id } })).status, 'sent');
  await prisma.$disconnect();
});
