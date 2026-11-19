// Runs only against a throwaway database: TEST_DATABASE_URL=postgresql://... npm test
// Never point this at production. It deletes all rows in the tables it uses.
import test from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;

test('follow ups: different sender starts a new thread, 404 retries unthreaded, API errors are not bounces', { skip: !url && 'TEST_DATABASE_URL not set' }, async () => {
  process.env.DATABASE_URL = url;
  const { prisma } = await import('../src/lib/prisma.js');
  const scheduler = await import('../src/services/sendScheduler.js');
  const campaignService = await import('../src/services/campaignService.js');
  const { sendCampaignEmail } = await import('../src/services/emailService.js');
  const { linkGmail } = await import('./helpers/gmail.js');
  const hooks = {
    recordSend: campaignService.recordSend,
    recordBounce: campaignService.recordBounce,
    maybeCompleteCampaign: campaignService.maybeCompleteCampaign,
  };

  for (const table of ['inboundReply', 'campaignRecipient', 'campaignStep', 'campaign', 'recipient', 'contactList', 'template', 'user', 'gmailAccount', 'workspace']) {
    await prisma[table].deleteMany({});
  }

  const ws = await prisma.workspace.create({ data: { name: 'RC', dailySendCap: 200 } });
  const user = await prisma.user.create({
    data: { email: 'owner@t.dev', name: 'H', passwordHash: 'x', role: 'owner', workspaceId: ws.id },
  });
  await prisma.workspaceMember.create({ data: { workspaceId: ws.id, userId: user.id, role: 'owner' } });
  const first = await linkGmail({ userId: user.id, workspaceId: ws.id, email: 'first@gmail.com' });
  const second = await prisma.gmailAccount.create({
    data: { email: 'second@gmail.com', refreshToken: 'enc', connectedAt: new Date(), connectedById: user.id },
  });
  const list = await prisma.contactList.create({ data: { workspaceId: ws.id, name: 'L' } });
  const tpl = await prisma.template.create({ data: { workspaceId: ws.id, name: 'T', body: '<p>Hi {{name}}</p>' } });
  const person = await prisma.recipient.create({
    data: { workspaceId: ws.id, email: 'lead@x.dev', name: 'Lead', organization: 'School', listId: list.id },
  });
  const campaign = await campaignService.createCampaign({
    workspaceId: ws.id,
    name: 'Outreach',
    subject: 'Email one',
    templateId: tpl.id,
    scheduledAt: new Date(),
    recipientIds: [person.id],
    listId: list.id,
    createdById: user.id,
  });
  const email1 = campaign.steps[0];
  await campaignService.recordSend({
    campaignId: campaign.id,
    recipientId: person.id,
    stepId: email1.id,
    messageId: 'm-email1',
    threadId: 't-email1',
    senderId: user.id,
    senderAccountId: first.id,
  });
  const { step: followUp } = await campaignService.createFollowUp({
    campaignId: campaign.id,
    subject: 'Follow up two',
    templateId: tpl.id,
  });
  await prisma.campaignStep.update({ where: { id: followUp.id }, data: { status: 'sending' } });

  // Different Gmail than Email 1: the follow up must go out as a new email.
  const differentCalls = [];
  const resultDifferent = await sendCampaignEmail({
    to: person.email,
    name: person.name,
    organization: person.organization,
    subject: followUp.subject,
    html: tpl.body,
    campaignId: campaign.id,
    recipientId: person.id,
    stepId: followUp.id,
    accountId: second.id,
    userId: user.id,
    workspaceId: ws.id,
    send: async (payload) => {
      differentCalls.push(payload);
      return { messageId: 'm-new', threadId: 't-new' };
    },
  });
  assert.equal(differentCalls.length, 1);
  assert.equal(differentCalls[0].threadId, undefined);
  assert.equal(differentCalls[0].inReplyTo, undefined);
  assert.equal(differentCalls[0].references, undefined);
  assert.equal(differentCalls[0].subject, 'Follow up two');
  assert.equal(resultDifferent.messageId, 'm-new');

  // Same Gmail as Email 1 would thread, but a 404 retries once unthreaded, same subject.
  const retryCalls = [];
  const resultRetry = await sendCampaignEmail({
    to: person.email,
    name: person.name,
    organization: person.organization,
    subject: followUp.subject,
    html: tpl.body,
    campaignId: campaign.id,
    recipientId: person.id,
    stepId: followUp.id,
    accountId: first.id,
    userId: user.id,
    workspaceId: ws.id,
    send: async (payload) => {
      retryCalls.push(payload);
      if (payload.threadId || payload.inReplyTo) {
        const err = new Error('Requested entity was not found.');
        err.code = 404;
        throw err;
      }
      return { messageId: 'm-retry', threadId: 't-retry' };
    },
  });
  assert.equal(retryCalls.length, 2);
  assert.equal(retryCalls[0].threadId, 't-email1');
  assert.equal(retryCalls[0].inReplyTo, 'm-email1');
  assert.equal(retryCalls[0].subject, 'Follow up two');
  assert.equal(retryCalls[1].threadId, undefined);
  assert.equal(retryCalls[1].inReplyTo, undefined);
  assert.equal(retryCalls[1].subject, 'Follow up two');
  assert.equal(resultRetry.messageId, 'm-retry');

  // A leftover 404 must not mark the contact bounced, and the follow up stays retryable.
  const err = new Error('Requested entity was not found.');
  err.code = 404;
  const failSend = async () => { throw err; };
  await prisma.gmailAccount.update({ where: { id: first.id }, data: { nextSendAt: null, sendingPausedAt: null } });
  const failed = await scheduler.sendOneForSender(await prisma.gmailAccount.findUnique({ where: { id: first.id } }), null, {
    now: new Date(),
    send: failSend,
    hooks,
  });
  assert.equal(failed.reason, 'send_error');
  const afterFail = await prisma.recipient.findUnique({ where: { id: person.id } });
  assert.equal(afterFail.status, 'active');
  assert.match(afterFail.lastError, /Requested entity was not found/);
  assert.equal(await prisma.campaignRecipient.count({ where: { stepId: followUp.id } }), 0);

  // A later successful send still works and clears the leftover error note.
  await prisma.gmailAccount.update({ where: { id: first.id }, data: { nextSendAt: null } });
  const sent = await scheduler.sendOneForSender(await prisma.gmailAccount.findUnique({ where: { id: first.id } }), null, {
    now: new Date(Date.now() + 60000),
    send: async () => ({ messageId: 'm-ok', threadId: 't-ok' }),
    hooks,
  });
  assert.equal(sent.sent, true);
  const afterOk = await prisma.recipient.findUnique({ where: { id: person.id } });
  assert.equal(afterOk.status, 'active');
  assert.equal(afterOk.lastError, '');
  assert.equal(await prisma.campaignRecipient.count({ where: { stepId: followUp.id, status: 'bounced' } }), 0);
  assert.equal(await prisma.campaignRecipient.count({ where: { stepId: followUp.id, status: 'sent' } }), 1);

  await prisma.$disconnect();
});

test('clear recipient send errors are still recorded as bounces', { skip: !url && 'TEST_DATABASE_URL not set' }, async () => {
  process.env.DATABASE_URL = url;
  const { prisma } = await import('../src/lib/prisma.js');
  const scheduler = await import('../src/services/sendScheduler.js');
  const campaignService = await import('../src/services/campaignService.js');
  const { linkGmail } = await import('./helpers/gmail.js');
  const hooks = {
    recordSend: campaignService.recordSend,
    recordBounce: campaignService.recordBounce,
    maybeCompleteCampaign: campaignService.maybeCompleteCampaign,
  };

  for (const table of ['inboundReply', 'campaignRecipient', 'campaignStep', 'campaign', 'recipient', 'contactList', 'template', 'user', 'gmailAccount', 'workspace']) {
    await prisma[table].deleteMany({});
  }

  const ws = await prisma.workspace.create({ data: { name: 'W', dailySendCap: 200 } });
  const user = await prisma.user.create({
    data: { email: 'owner2@t.dev', name: 'H', passwordHash: 'x', role: 'owner', workspaceId: ws.id },
  });
  await prisma.workspaceMember.create({ data: { workspaceId: ws.id, userId: user.id, role: 'owner' } });
  const acct = await linkGmail({ userId: user.id, workspaceId: ws.id, email: 'sender@gmail.com' });
  const list = await prisma.contactList.create({ data: { workspaceId: ws.id, name: 'L' } });
  const tpl = await prisma.template.create({ data: { workspaceId: ws.id, name: 'T', body: '<p>Hi</p>' } });
  const person = await prisma.recipient.create({
    data: { workspaceId: ws.id, email: 'bad@x.dev', name: 'Bad', listId: list.id },
  });
  const campaign = await campaignService.createCampaign({
    workspaceId: ws.id,
    name: 'C',
    subject: 'S',
    templateId: tpl.id,
    scheduledAt: new Date(),
    recipientIds: [person.id],
    listId: list.id,
    createdById: user.id,
  });
  await prisma.campaignStep.updateMany({ where: { campaignId: campaign.id }, data: { status: 'sending' } });

  const bounceErr = new Error('Invalid To header');
  bounceErr.code = 400;
  const result = await scheduler.sendOneForSender(await prisma.gmailAccount.findUnique({ where: { id: acct.id } }), null, {
    now: new Date(),
    send: async () => { throw bounceErr; },
    hooks,
  });
  assert.equal(result.reason, 'bounced');
  const after = await prisma.recipient.findUnique({ where: { id: person.id } });
  assert.equal(after.status, 'bounced');
  assert.equal(await prisma.campaignRecipient.count({ where: { campaignId: campaign.id, status: 'bounced' } }), 1);

  await prisma.$disconnect();
});
