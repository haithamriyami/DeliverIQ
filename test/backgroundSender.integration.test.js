// Runs only against a throwaway database: TEST_DATABASE_URL=postgresql://... npm test
// Never point this at production. It deletes all rows in the tables it uses.
import test from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;

test('background run keeps sending at the gap, one run at a time, overlap never double sends', { skip: !url && 'TEST_DATABASE_URL not set', timeout: 120000 }, async () => {
  process.env.DATABASE_URL = url;
  process.env.NODE_ENV = 'production';
  delete process.env.REDIS_URL;
  process.env.SESSION_SECRET = 'test-secret';
  const { google } = await import('googleapis');
  const crypto = await import('crypto');
  const sentAt = [];
  google.gmail = () => ({
    users: { messages: { send: async ({ requestBody }) => {
      const raw = Buffer.from(requestBody.raw, 'base64url').toString('utf8');
      sentAt.push({ at: Date.now(), to: raw.match(/^To: (.+)$/m)[1].trim() });
      return { data: { id: `m${sentAt.length}`, threadId: `t${sentAt.length}` } };
    } } },
  });
  const key = crypto.createHash('sha256').update('test-secret').digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const encToken = `${iv.toString('hex')}:${Buffer.concat([cipher.update('refresh'), cipher.final()]).toString('hex')}`;

  const { prisma } = await import('../src/lib/prisma.js');
  const cs = await import('../src/services/campaignService.js');
  const bg = await import('../src/services/backgroundSender.js');

  for (const table of ['schedulerLease', 'inboundReply', 'campaignRecipient', 'campaignStep', 'campaign', 'recipient', 'contactList', 'template', 'user', 'workspace']) {
    await prisma[table].deleteMany({});
  }
  // Minimum allowed gap, no jitter, so the test runs in seconds.
  const ws = await prisma.workspace.create({ data: { name: 'W', sendGapSeconds: 5, sendJitterSeconds: 0 } });
  const user = await prisma.user.create({
    data: { email: 'o@t.dev', name: 'H', passwordHash: 'x', role: 'owner', workspaceId: ws.id, gmailEmail: 'f@gmail.com', gmailRefreshToken: encToken },
  });
  const list = await prisma.contactList.create({ data: { name: 'L' } });
  const tpl = await prisma.template.create({ data: { name: 'T', body: '<p>Hi</p>' } });
  const ids = [];
  for (let i = 0; i < 8; i += 1) ids.push((await prisma.recipient.create({ data: { email: `p${i}@x.dev`, name: 'P', listId: list.id } })).id);
  const c = await cs.createCampaign({ name: 'C', subject: 'S', templateId: tpl.id, scheduledAt: new Date(), recipientIds: ids, listId: list.id, createdById: user.id });

  // Lease: only one holder until it is released or expires.
  assert.equal(await bg.acquireLease('a', 60000), true);
  assert.equal(await bg.acquireLease('b', 60000), false);
  await bg.releaseLease('a');
  assert.equal(await bg.acquireLease('b', 1), true);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(await bg.acquireLease('c', 60000), true, 'expired lease can be taken over');
  await bg.releaseLease('c');

  // Pressing Send: the first email goes out at once.
  const t0 = Date.now();
  const first = await cs.enqueueCampaign(c.id);
  assert.equal(first.enqueued, 1);
  assert.ok(sentAt[0].at - t0 < 3000, 'first email right away');

  // Two background runs started together: one runs, the other returns immediately.
  let chainedCalls = 0;
  const trigger = async () => { chainedCalls += 1; return true; };
  const [r1, r2] = await Promise.all([
    bg.runBackgroundSender({ budgetMs: 12000, trigger }),
    bg.runBackgroundSender({ budgetMs: 12000, trigger }),
  ]);
  const ran = [r1, r2].find((r) => !r.skipped);
  assert.ok([r1, r2].some((r) => r.skipped === 'already_running'));
  assert.ok(ran.sent >= 2, `background run kept sending (${ran.sent})`);
  assert.equal(ran.chained, true, 'work left, so it starts the next run');
  assert.equal(chainedCalls, 1);

  // Overlap without the lease (e.g. legacy loop + run): the slot claim still holds the gap.
  await Promise.all([cs.runSchedulerTick({ budgetMs: 6000 }), cs.runSchedulerTick({ budgetMs: 6000 })]);

  const times = sentAt.map((row) => row.at);
  for (let i = 1; i < times.length; i += 1) {
    assert.ok(times[i] - times[i - 1] >= 4900, `gap ${times[i] - times[i - 1]} ms between emails ${i} and ${i + 1}`);
  }
  const recipients = sentAt.map((row) => row.to);
  assert.equal(new Set(recipients).size, recipients.length, 'nobody got the same email twice');
  const rows = await prisma.campaignRecipient.count({ where: { campaignId: c.id, status: 'sent' } });
  assert.equal(rows, sentAt.length);

  // Kill switch: a run sends nothing and does not chain.
  await prisma.workspace.update({ where: { id: ws.id }, data: { sendingPausedAt: new Date() } });
  await prisma.user.update({ where: { id: user.id }, data: { nextSendAt: null } });
  const before = sentAt.length;
  const paused = await bg.runBackgroundSender({ budgetMs: 3000, trigger });
  assert.equal(paused.sent, 0);
  assert.equal(paused.chained, false);
  assert.equal(sentAt.length, before);

  await prisma.$disconnect();
});
