// Runs only against a throwaway database: TEST_DATABASE_URL=postgresql://... npm test
// Never point this at production. It deletes all rows in the tables it uses.
import test from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;

test('scheduler: gap, daily cap, follow-up skip for replied contacts', { skip: !url && 'TEST_DATABASE_URL not set' }, async () => {
  process.env.DATABASE_URL = url;
  const { prisma } = await import('../src/lib/prisma.js');
  const scheduler = await import('../src/services/sendScheduler.js');
  const campaignService = await import('../src/services/campaignService.js');
  const hooks = {
    recordSend: campaignService.recordSend,
    recordBounce: campaignService.recordBounce,
    maybeCompleteCampaign: campaignService.maybeCompleteCampaign,
  };

  for (const table of ['inboundReply', 'campaignRecipient', 'campaignStep', 'campaign', 'recipient', 'contactList', 'template', 'user', 'workspace']) {
    await prisma[table].deleteMany({});
  }

  const ws = await prisma.workspace.create({ data: { name: 'Test', dailySendCap: 3 } });
  const user = await prisma.user.create({
    data: { email: 'o@test.dev', name: 'Haitham Soud', passwordHash: 'x', role: 'owner', workspaceId: ws.id, gmailEmail: 'o@gmail.com', gmailRefreshToken: 'enc' },
  });
  const list = await prisma.contactList.create({ data: { name: 'L' } });
  const tpl = await prisma.template.create({ data: { name: 'T', body: '<p>Hi {{name}}</p>' } });
  const people = [];
  for (let i = 0; i < 5; i += 1) {
    people.push(await prisma.recipient.create({ data: { email: `p${i}@x.dev`, name: `P${i}`, listId: list.id } }));
  }
  const campaign = await campaignService.createCampaign({
    name: 'C', subject: 'S', templateId: tpl.id, scheduledAt: new Date(), recipientIds: people.map((p) => p.id), listId: list.id, createdById: user.id,
  });
  await prisma.campaignStep.updateMany({ where: { campaignId: campaign.id }, data: { status: 'sending' } });

  const sent = [];
  const send = async ({ to }) => { sent.push(to); return { messageId: `m-${to}`, threadId: `t-${to}` }; };
  const settings = await scheduler.workspaceSendSettings(ws.id);
  const fresh = () => prisma.user.findUnique({ where: { id: user.id } });

  // 10:00 Nairobi = 07:00 UTC.
  let now = new Date('2026-10-14T07:00:00Z');
  let r = await scheduler.sendOneForSender(await fresh(), settings, { now, send, hooks });
  assert.equal(r.sent, true);
  const after1 = (await fresh()).nextSendAt.getTime() - now.getTime();
  assert.ok(after1 >= 30000 && after1 <= 40000);

  // 10 s later: blocked by the gap.
  r = await scheduler.sendOneForSender(await fresh(), settings, { now: new Date(now.getTime() + 10000), send, hooks });
  assert.equal(r.reason, 'gap');

  // Concurrent claim: only one of two simultaneous ticks may send.
  now = new Date(now.getTime() + 41000);
  const u = await fresh();
  const both = await Promise.all([
    scheduler.sendOneForSender(u, settings, { now, send, hooks }),
    scheduler.sendOneForSender(u, settings, { now, send, hooks }),
  ]);
  assert.equal(both.filter((x) => x.sent).length, 1);

  // Mark sentAt "today" in real time for the cap check by sending with real clock values.
  now = new Date(now.getTime() + 41000);
  r = await scheduler.sendOneForSender(await fresh(), settings, { now, send, hooks });
  assert.equal(r.sent, true);
  assert.equal(sent.length, 3);

  // Cap is 3 for this test workspace. Rows have sentAt = real now, so count with real now.
  const realNow = new Date();
  await prisma.user.update({ where: { id: user.id }, data: { nextSendAt: null } });
  r = await scheduler.sendOneForSender(await fresh(), settings, { now: realNow, send, hooks });
  assert.equal(r.reason, 'daily_cap');
  assert.equal(await scheduler.queuedCountForSender(await fresh()), 2);

  // A human reply stops follow-ups for that person; opt out marks do not contact.
  await prisma.recipient.update({ where: { id: people[0].id }, data: { repliedAt: new Date() } });
  await prisma.recipient.update({ where: { id: people[1].id }, data: { repliedAt: new Date(), doNotContact: true, status: 'unsubscribed' } });
  await prisma.workspace.update({ where: { id: ws.id }, data: { dailySendCap: 200 } });
  const { step } = await campaignService.createFollowUp({ campaignId: campaign.id, subject: 'Follow', templateId: tpl.id });
  assert.ok(!step.recipientIds.includes(people[0].id));
  assert.ok(!step.recipientIds.includes(people[1].id));

  // Paused sender never sends.
  await scheduler.pauseSender(user.id, 'test');
  r = await scheduler.sendOneForSender(await fresh(), await scheduler.workspaceSendSettings(ws.id), { now: new Date(Date.now() + 3600000), send, hooks });
  assert.equal(r.reason, 'paused');

  await prisma.$disconnect();
});
