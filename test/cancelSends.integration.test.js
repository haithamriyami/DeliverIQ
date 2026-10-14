// Runs only against a throwaway database: TEST_DATABASE_URL=postgresql://... npm test
// Never point this at production. It deletes all rows in the tables it uses.
import test from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;

test('deleted, stopped, paused and kill-switched campaigns never send', { skip: !url && 'TEST_DATABASE_URL not set' }, async () => {
  process.env.DATABASE_URL = url;
  process.env.NODE_ENV = 'production'; // no Redis in tests, like Vercel
  delete process.env.REDIS_URL;
  const { prisma } = await import('../src/lib/prisma.js');
  const scheduler = await import('../src/services/sendScheduler.js');
  const cs = await import('../src/services/campaignService.js');
  const hooks = { recordSend: cs.recordSend, recordBounce: cs.recordBounce, maybeCompleteCampaign: cs.maybeCompleteCampaign };

  for (const table of ['inboundReply', 'campaignRecipient', 'campaignStep', 'campaign', 'recipient', 'contactList', 'template', 'user', 'workspace']) {
    await prisma[table].deleteMany({});
  }
  const ws = await prisma.workspace.create({ data: { name: 'W' } });
  const user = await prisma.user.create({
    data: { email: 'o@t.dev', name: 'H', passwordHash: 'x', role: 'owner', workspaceId: ws.id, gmailEmail: 'f@gmail.com', gmailRefreshToken: 'enc' },
  });
  const list = await prisma.contactList.create({ data: { name: 'L' } });
  const tpl = await prisma.template.create({ data: { name: 'T', body: '<p>Hi</p>' } });
  let n = 0;
  const makeCampaign = async (name) => {
    const ids = [];
    for (let i = 0; i < 3; i += 1) ids.push((await prisma.recipient.create({ data: { email: `${name}${i}@x.dev`, name: 'P', listId: list.id } })).id);
    const c = await cs.createCampaign({ name, subject: 'S', templateId: tpl.id, scheduledAt: new Date(), recipientIds: ids, listId: list.id, createdById: user.id });
    await prisma.campaignStep.updateMany({ where: { campaignId: c.id }, data: { status: 'sending' } });
    return { ...c, ids };
  };
  const sends = [];
  const send = async (args) => { sends.push(args); n += 1; return { messageId: `m${n}`, threadId: `t${n}` }; };
  const settings = await scheduler.workspaceSendSettings(ws.id);
  const me = () => prisma.user.findUnique({ where: { id: user.id } });
  const tick = async () => {
    await prisma.user.update({ where: { id: user.id }, data: { nextSendAt: null } });
    return scheduler.sendOneForSender(await me(), settings, { now: new Date(), send, hooks });
  };

  // 1. Deleting cancels everything queued.
  const mistake = await makeCampaign('mistake');
  assert.equal((await tick()).sent, true);
  await cs.deleteCampaign(mistake.id);
  const afterDelete = await tick();
  assert.equal(afterDelete.sent, false);
  assert.equal(afterDelete.reason, 'idle');
  assert.equal(sends.length, 1);
  assert.equal(await scheduler.queuedCountForSender(await me()), 0);
  assert.equal(await prisma.campaignStep.count({ where: { campaignId: mistake.id } }), 0, 'no orphaned steps');
  assert.equal(await prisma.campaignRecipient.count({ where: { campaignId: mistake.id } }), 0, 'no orphaned rows');

  // 2. Final check right before sending sees a delete that happened after work was picked.
  const racing = await makeCampaign('racing');
  const work = await scheduler.nextPendingForSender(await me());
  assert.equal(work.campaign.id, racing.id);
  const args = { senderId: user.id, workspaceId: ws.id, stepId: work.step.id, campaignId: racing.id, recipientId: work.recipient.id };
  assert.equal(await scheduler.blockReasonAtSendTime(args), null);
  await scheduler.pauseCampaign(racing.id, 'Stopped');
  assert.equal(await scheduler.blockReasonAtSendTime(args), 'campaign_paused');
  assert.equal((await tick()).reason, 'idle', 'stopped campaign is not picked');
  await scheduler.resumeCampaign(racing.id);
  await cs.deleteCampaign(racing.id);
  assert.equal(await scheduler.blockReasonAtSendTime(args), 'campaign_deleted');

  // 3. Campaign deleted while the Gmail call is in flight: the email counts as sent, the
  //    contact is NOT marked bounced.
  const inflight = await makeCampaign('inflight');
  const deletingSend = async (a) => { await cs.deleteCampaign(inflight.id); return send(a); };
  await prisma.user.update({ where: { id: user.id }, data: { nextSendAt: null } });
  const r = await scheduler.sendOneForSender(await me(), settings, { now: new Date(), send: deletingSend, hooks });
  assert.equal(r.sent, true);
  const person = await prisma.recipient.findUnique({ where: { email: r.email } });
  assert.equal(person.status, 'active');

  // 4. Global kill switch stops every account, and a skipped slot is given back.
  const live = await makeCampaign('live');
  await scheduler.setGlobalPause(ws.id, true, 'test');
  const before = sends.length;
  assert.equal((await tick()).reason, 'paused');
  const w2 = await scheduler.nextPendingForSender(await me());
  assert.equal(
    await scheduler.blockReasonAtSendTime({ senderId: user.id, workspaceId: ws.id, stepId: w2.step.id, campaignId: live.id, recipientId: w2.recipient.id }),
    'global_paused'
  );
  const tickResult = await cs.runSchedulerTick({ budgetMs: 0 });
  assert.equal(tickResult.results.length, 0);
  assert.equal(sends.length, before);
  await scheduler.setGlobalPause(ws.id, false);
  assert.equal((await tick()).sent, true);

  // 5. Contacts wrongly bounced by the old race are repaired automatically and idempotently.
  const victim = await prisma.recipient.create({ data: { email: 'victim@x.dev', name: 'V', listId: list.id, status: 'bounced', lastError: 'Follow-up not found' } });
  const real = await prisma.recipient.create({ data: { email: 'real@x.dev', name: 'R', listId: list.id, status: 'bounced', lastError: 'Gmail: address not found or mailbox unavailable.' } });
  await cs.listCampaignsWithStats();
  await cs.listCampaignsWithStats();
  assert.equal((await prisma.recipient.findUnique({ where: { id: victim.id } })).status, 'active');
  assert.equal((await prisma.recipient.findUnique({ where: { id: real.id } })).status, 'bounced');

  await prisma.$disconnect();
});
