// Runs only against a throwaway database: TEST_DATABASE_URL=postgresql://... npm test
// Never point this at production. It deletes all rows in the tables it uses.
import test from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
const QUOTA_MSG = "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user' of service 'gmail.googleapis.com'";

test('inbox sync is throttled, leased, incremental, and quota errors never pause sending', { skip: !url && 'TEST_DATABASE_URL not set' }, async () => {
  process.env.DATABASE_URL = url;
  process.env.NODE_ENV = 'production';
  delete process.env.REDIS_URL;
  const { prisma } = await import('../src/lib/prisma.js');
  const inbox = await import('../src/services/inboxSync.js');
  const scheduler = await import('../src/services/sendScheduler.js');
  const cs = await import('../src/services/campaignService.js');

  for (const table of ['schedulerLease', 'inboundReply', 'campaignRecipient', 'campaignStep', 'campaign', 'recipient', 'contactList', 'template', 'user', 'workspace']) {
    await prisma[table].deleteMany({});
  }
  const ws = await prisma.workspace.create({ data: { name: 'W', dailySendCap: 300 } });
  const user = await prisma.user.create({
    data: { email: 'o@t.dev', name: 'H', passwordHash: 'x', role: 'owner', workspaceId: ws.id, gmailEmail: 'f@gmail.com', gmailRefreshToken: 'enc' },
  });
  const me = () => prisma.user.findUnique({ where: { id: user.id } });

  const calls = [];
  let fail = null;
  const fetchDelta = async (_id, opts) => {
    calls.push(opts);
    await new Promise((r) => setTimeout(r, 50));
    if (fail) throw fail;
    return { messages: [], historyId: String(1000 + calls.length), senderEmail: 'f@gmail.com' };
  };
  const t0 = new Date('2026-10-30T08:00:00Z');
  const at = (ms) => new Date(t0.getTime() + ms);

  // First sync runs; a second one right after is throttled.
  assert.equal((await inbox.syncInboxForUser(await me(), { now: t0, fetchDelta })).skipped, false);
  assert.equal((await inbox.syncInboxForUser(await me(), { now: at(60000), fetchDelta })).skipped, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].historyId, null);
  assert.equal((await me()).gmailHistoryId, '1001');

  // After 5 minutes it runs again, incrementally from the stored historyId.
  assert.equal((await inbox.syncInboxForUser(await me(), { now: at(5 * 60000), fetchDelta })).skipped, false);
  assert.equal(calls[1].historyId, '1001');
  assert.ok(calls[1].max <= 50, 'bounded message gets');

  // Two overlapping syncs: the lease lets only one fetch.
  const u = await me();
  const both = await Promise.all([
    inbox.syncInboxForUser(u, { now: at(10 * 60000), fetchDelta }),
    inbox.syncInboxForUser(u, { now: at(10 * 60000), fetchDelta }),
  ]);
  assert.equal(both.filter((r) => !r.skipped).length, 1);
  assert.equal(calls.length, 3);

  // Read quota error: back off with a quiet notice; sending is NOT paused.
  fail = Object.assign(new Error(QUOTA_MSG), { code: 429, response: { headers: { 'retry-after': '120' } } });
  const failed = await inbox.syncInboxForUser(await me(), { now: at(15 * 60000), fetchDelta });
  assert.equal(failed.quota, true);
  let fresh = await me();
  assert.equal(fresh.sendingPausedAt, null, 'sending not paused');
  assert.equal(fresh.inboxSyncErrors, 1);
  assert.equal(fresh.inboxSyncNotBefore.getTime(), at(15 * 60000 + 120000).getTime(), 'Retry-After honored');
  assert.match(fresh.inboxSyncNotice, /Sending is not affected/);
  // During backoff: skipped, even when forced.
  assert.equal((await inbox.syncInboxForUser(fresh, { now: at(16 * 60000), force: true, fetchDelta })).skipped, true);
  // Second failure doubles the wait (2 min base * 2^1 = 2 min vs exp 2 min).
  const f2 = await inbox.syncInboxForUser(await me(), { now: at(21 * 60000), fetchDelta });
  assert.equal(f2.quota, true);
  fresh = await me();
  assert.equal(fresh.inboxSyncErrors, 2);
  assert.ok(fresh.inboxSyncNotBefore.getTime() - at(21 * 60000).getTime() >= 120000);
  // Recovery clears the notice and error count.
  fail = null;
  assert.equal((await inbox.syncInboxForUser(await me(), { now: at(40 * 60000), fetchDelta })).skipped, false);
  fresh = await me();
  assert.equal(fresh.inboxSyncNotice, '');
  assert.equal(fresh.inboxSyncErrors, 0);

  // Send hitting the per minute quota: short backoff, no pause.
  const list = await prisma.contactList.create({ data: { name: 'L' } });
  const tpl = await prisma.template.create({ data: { name: 'T', body: '<p>Hi</p>' } });
  const r1 = await prisma.recipient.create({ data: { email: 'p@x.dev', name: 'P', listId: list.id } });
  const c = await cs.createCampaign({ name: 'C', subject: 'S', templateId: tpl.id, scheduledAt: new Date(), recipientIds: [r1.id], listId: list.id, createdById: user.id });
  await prisma.campaignStep.updateMany({ where: { campaignId: c.id }, data: { status: 'sending' } });
  const hooks = { recordSend: cs.recordSend, recordBounce: cs.recordBounce, maybeCompleteCampaign: cs.maybeCompleteCampaign };
  const now = new Date();
  const res = await scheduler.sendOneForSender(await me(), await scheduler.workspaceSendSettings(ws.id), {
    now,
    hooks,
    send: async () => { throw Object.assign(new Error(QUOTA_MSG), { code: 429 }); },
  });
  assert.equal(res.reason, 'backoff');
  fresh = await me();
  assert.equal(fresh.sendingPausedAt, null);
  assert.ok(fresh.nextSendAt.getTime() >= now.getTime() + 59000);
  assert.equal((await prisma.recipient.findUnique({ where: { id: r1.id } })).status, 'active', 'not a bounce');

  // Auto recover: old quota pauses resume, real pauses stay.
  await prisma.user.update({
    where: { id: user.id },
    data: { sendingPausedAt: new Date(), sendingPausedReason: `Gmail returned a rate limit, policy or account restriction error, so all sending from this account is paused. Check the Gmail account, then press Resume. Gmail said: ${QUOTA_MSG}` },
  });
  const other = await prisma.user.create({
    data: { email: 'b@t.dev', name: 'B', passwordHash: 'x', workspaceId: ws.id, gmailEmail: 'b@gmail.com', gmailRefreshToken: 'enc', sendingPausedAt: new Date(), sendingPausedReason: 'Gmail said: Mail service not enabled: account suspended' },
  });
  assert.equal(await scheduler.resumeQuotaPausedSenders(), 1);
  assert.equal(await scheduler.resumeQuotaPausedSenders(), 0, 'idempotent');
  assert.equal((await me()).sendingPausedAt, null);
  assert.notEqual((await prisma.user.findUnique({ where: { id: other.id } })).sendingPausedAt, null);

  await prisma.$disconnect();
});
