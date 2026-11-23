// Runs only against a throwaway database: TEST_DATABASE_URL=postgresql://... npm test
// Never point this at production. It deletes all rows in the tables it uses.
import test from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
const HOUR = 3600000;

async function setup() {
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
  const ws = await prisma.workspace.create({ data: { name: 'FB', dailySendCap: 3 } });
  const user = await prisma.user.create({
    data: { email: 'fb@t.dev', name: 'H', passwordHash: 'x', role: 'owner', workspaceId: ws.id },
  });
  await prisma.workspaceMember.create({ data: { workspaceId: ws.id, userId: user.id, role: 'owner' } });
  const acct = await linkGmail({ userId: user.id, workspaceId: ws.id, email: 'fb@gmail.com' });
  const list = await prisma.contactList.create({ data: { workspaceId: ws.id, name: 'L' } });
  const tpl = await prisma.template.create({ data: { workspaceId: ws.id, name: 'T', body: '<p>Hi</p>' } });
  const people = [];
  for (let i = 0; i < 6; i += 1) {
    people.push(await prisma.recipient.create({ data: { workspaceId: ws.id, email: `p${i}@x.dev`, name: `P${i}`, listId: list.id } }));
  }
  const campaign = await campaignService.createCampaign({
    workspaceId: ws.id,
    name: 'C',
    subject: 'S',
    templateId: tpl.id,
    scheduledAt: new Date(),
    recipientIds: people.map((p) => p.id),
    listId: list.id,
    createdById: user.id,
  });
  await prisma.campaignStep.updateMany({ where: { campaignId: campaign.id }, data: { status: 'sending' } });
  const step = (await prisma.campaignStep.findMany({ where: { campaignId: campaign.id } }))[0];
  const fresh = () => prisma.gmailAccount.findUnique({ where: { id: acct.id } });
  /** Record a past send for person i at a given time. */
  const pastSend = async (i, at) => {
    await campaignService.recordSend({
      campaignId: campaign.id, recipientId: people[i].id, stepId: step.id,
      messageId: `m${i}`, threadId: `t${i}`, senderId: user.id, senderAccountId: acct.id,
    });
    await prisma.campaignRecipient.update({
      where: { stepId_recipientId: { stepId: step.id, recipientId: people[i].id } },
      data: { sentAt: at },
    });
  };
  return { prisma, scheduler, hooks, ws, acct, people, step, fresh, pastSend };
}

test('daily cap counts the last 24 hours, so a new Nairobi day does not reset it', { skip: !url && 'TEST_DATABASE_URL not set' }, async () => {
  const { prisma, scheduler, hooks, ws, acct, step, fresh, pastSend } = await setup();
  const now = new Date();
  // Three sends 20, 10 and 2 hours ago. At least one is "yesterday" in Nairobi, yet all count.
  await pastSend(0, new Date(now - 20 * HOUR));
  await pastSend(1, new Date(now - 10 * HOUR));
  await pastSend(2, new Date(now - 2 * HOUR));
  const send = async () => ({ messageId: 'new', threadId: 'new' });

  let r = await scheduler.sendOneForSender(await fresh(), null, { now, send, hooks });
  assert.equal(r.reason, 'daily_cap');
  // Room frees up when the oldest counted send is 24 hours old.
  assert.equal(r.retryAt.getTime(), now.getTime() - 20 * HOUR + 24 * HOUR);

  const status = await scheduler.sendingStatus(ws.id);
  assert.equal(status.senders[0].sentToday, 3);
  assert.equal(status.senders[0].capReached, true);
  assert.equal(new Date(status.senders[0].resumesAt).getTime(), now.getTime() - 20 * HOUR + 24 * HOUR);

  // Once that send is older than 24 hours, one more may go out.
  await prisma.campaignRecipient.updateMany({ where: { stepId: step.id, sentAt: { lt: new Date(now - 15 * HOUR) } }, data: { sentAt: new Date(now - 25 * HOUR) } });
  r = await scheduler.sendOneForSender(await fresh(), null, { now: new Date(), send, hooks });
  assert.equal(r.sent, true);
  assert.equal(await scheduler.sentTodayCount(acct.id), 3);
  await prisma.$disconnect();
});

test('Gmail daily sending limit holds the account until room frees up: no retry loop, no bounce, clear status', { skip: !url && 'TEST_DATABASE_URL not set' }, async () => {
  const { prisma, scheduler, hooks, ws, acct, people, step, fresh, pastSend } = await setup();
  await prisma.workspace.update({ where: { id: ws.id }, data: { dailySendCap: 500 } });
  const now = new Date();
  // Oldest send in the window was 13 hours ago: Gmail frees room 11 hours from now.
  await pastSend(0, new Date(now - 13 * HOUR));
  await pastSend(1, new Date(now - 1 * HOUR));

  const gmailSays = new Date(now.getTime() + 15 * 60000);
  const limitErr = new Error(`User-rate limit exceeded.  Retry after ${gmailSays.toISOString()} (Mail sending)`);
  limitErr.code = 429;
  let calls = 0;
  const failing = async () => { calls += 1; throw limitErr; };

  const r = await scheduler.sendOneForSender(await fresh(), null, { now, send: failing, hooks });
  assert.equal(r.reason, 'daily_limit');
  const expected = now.getTime() - 13 * HOUR + 24 * HOUR;
  assert.ok(Math.abs(r.retryAt.getTime() - expected) < 2000, 'held until the oldest send ages out, not Gmail\'s 15 minutes');

  const held = await fresh();
  assert.equal(held.sendingPausedAt, null, 'a hold, not a pause: it resumes by itself');
  assert.equal(held.sendBackoffCount, 0);
  assert.match(held.sendingPausedReason, /^Gmail daily sending limit reached/);
  assert.ok(Math.abs(held.nextSendAt.getTime() - expected) < 2000);

  // Not a bounce: no row for the contact, contact active, no lastError.
  assert.equal(await prisma.campaignRecipient.count({ where: { stepId: step.id } }), 2);
  for (const p of people.slice(2)) {
    const row = await prisma.recipient.findUnique({ where: { id: p.id } });
    assert.equal(row.status, 'active');
    assert.equal(row.lastError, '');
  }

  // No retry loop: ticks during the hold do not call Gmail at all.
  const before = calls;
  for (const minutes of [15, 30, 60, 180]) {
    const later = await scheduler.sendOneForSender(await fresh(), null, { now: new Date(now.getTime() + minutes * 60000), send: failing, hooks });
    assert.equal(later.sent, false);
  }
  assert.equal(calls, before);

  // The app shows it.
  const status = await scheduler.sendingStatus(ws.id);
  const sender = status.senders[0];
  assert.equal(sender.gmailLimitReached, true);
  assert.equal(new Date(sender.gmailLimitUntil).getTime(), held.nextSendAt.getTime());
  assert.equal(sender.paused, false);
  assert.equal(sender.queued, 4);

  // After the hold, the next send goes out and the note is cleared.
  const after = await scheduler.sendOneForSender(await fresh(), null, {
    now: new Date(held.nextSendAt.getTime() + 1000),
    send: async () => ({ messageId: 'ok', threadId: 'ok' }),
    hooks,
  });
  assert.equal(after.sent, true);
  const cleared = await fresh();
  assert.equal(cleared.sendingPausedReason, '');
  assert.equal((await scheduler.sendingStatus(ws.id)).senders[0].gmailLimitReached, false);

  // Gmail's retry time wins when it is later than the window estimate, capped at 24 hours.
  await prisma.gmailAccount.update({ where: { id: acct.id }, data: { nextSendAt: null } });
  const farErr = new Error(`User-rate limit exceeded.  Retry after ${new Date(now.getTime() + 40 * HOUR).toISOString()} (Mail sending)`);
  const r2 = await scheduler.sendOneForSender(await fresh(), null, { now: new Date(), send: async () => { throw farErr; }, hooks });
  assert.equal(r2.reason, 'daily_limit');
  assert.ok(r2.retryAt.getTime() <= Date.now() + 24 * HOUR + 1000);
  assert.ok(r2.retryAt.getTime() >= Date.now() + 23 * HOUR);
  await prisma.$disconnect();
});
