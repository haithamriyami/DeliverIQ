// Runs only against a throwaway database: TEST_DATABASE_URL=postgresql://... npm test
// Never point this at production. It deletes all rows in the tables it uses.
import test from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;

test('throttled sends show up in campaign counts, Sent list and tracking; stale older steps are not sent', { skip: !url && 'TEST_DATABASE_URL not set' }, async () => {
  process.env.DATABASE_URL = url;
  process.env.SESSION_SECRET = 'test-secret';
  // Fake Gmail: capture the raw MIME so we test the real send path, tracking included.
  const { google } = await import('googleapis');
  const crypto = await import('crypto');
  const raws = [];
  google.gmail = () => ({
    users: { messages: { send: async ({ requestBody }) => { raws.push(Buffer.from(requestBody.raw, 'base64url').toString('utf8')); return { data: { id: `m${raws.length}`, threadId: `t${raws.length}` } }; } } },
  });
  const key = crypto.createHash('sha256').update('test-secret').digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const encToken = `${iv.toString('hex')}:${Buffer.concat([cipher.update('refresh'), cipher.final()]).toString('hex')}`;
  const { prisma } = await import('../src/lib/prisma.js');
  const scheduler = await import('../src/services/sendScheduler.js');
  const cs = await import('../src/services/campaignService.js');
  const { parseTrackingToken } = await import('../src/utils/tracking.js');
  const hooks = { recordSend: cs.recordSend, recordBounce: cs.recordBounce, maybeCompleteCampaign: cs.maybeCompleteCampaign };

  for (const table of ['inboundReply', 'campaignRecipient', 'campaignStep', 'campaign', 'recipient', 'contactList', 'template', 'user', 'workspace']) {
    await prisma[table].deleteMany({});
  }
  const ws = await prisma.workspace.create({ data: { name: 'W' } });
  const user = await prisma.user.create({
    data: { email: 'o@t.dev', name: 'H', passwordHash: 'x', role: 'owner', workspaceId: ws.id, gmailEmail: 'f@gmail.com', gmailRefreshToken: encToken },
  });
  const list = await prisma.contactList.create({ data: { name: 'L' } });
  const tpl = await prisma.template.create({ data: { name: 'T', body: '<p>Hi <a href="https://example.com">link</a></p>' } });
  const mk = async (prefix, n) => {
    const ids = [];
    for (let i = 0; i < n; i += 1) ids.push((await prisma.recipient.create({ data: { email: `${prefix}${i}@x.dev`, name: 'P', listId: list.id } })).id);
    return ids;
  };

  // Old campaign from the pre-throttle batch sender: Email 1 left in "sending" with people
  // still waiting, then a follow-up was created. Its Email 1 must not be resumed silently.
  const oldIds = await mk('old', 3);
  const old = await cs.createCampaign({ name: 'Old', subject: 'S', templateId: tpl.id, scheduledAt: new Date(), recipientIds: oldIds, listId: list.id, createdById: user.id });
  await prisma.campaignStep.updateMany({ where: { campaignId: old.id }, data: { status: 'sending' } });
  await prisma.campaignStep.create({ data: { campaignId: old.id, stepNumber: 2, name: 'Follow-up 2', subject: 'F', templateId: tpl.id, status: 'pending', recipientIds: oldIds } });

  const newIds = await mk('new', 3);
  const fresh = await cs.createCampaign({ name: 'Construction', subject: 'S', templateId: tpl.id, scheduledAt: new Date(), recipientIds: newIds, listId: list.id, createdById: user.id });
  await prisma.campaignStep.updateMany({ where: { campaignId: fresh.id }, data: { status: 'sending' } });

  const settings = await scheduler.workspaceSendSettings(ws.id);
  let now = Date.now();
  for (let i = 0; i < 2; i += 1) {
    const u = await prisma.user.findUnique({ where: { id: user.id } });
    const r = await scheduler.sendOneForSender(u, settings, { now: new Date(now), hooks });
    assert.equal(r.sent, true);
    assert.equal(r.campaignId, fresh.id, 'must send the visible queued campaign, not the stale old step');
    now += 41000;
  }

  const rows = await cs.listCampaignsWithStats();
  const c = rows.find((row) => row.id === fresh.id);
  assert.equal(c.totals.sent, 2);
  assert.equal(c.totals.pending, 1);
  assert.equal(c.status, 'sending');
  const o = rows.find((row) => row.id === old.id);
  assert.equal(o.steps[0].status, 'completed', 'superseded Email 1 is closed');
  assert.equal(await scheduler.queuedCountForSender(user), 1);

  // Sent list and tracking for a throttled send.
  const sentList = await cs.listCampaignAudience(fresh.id, 'sent');
  assert.equal(sentList.length, 2);
  assert.equal(raws.length, 2);
  const html = raws[0];
  assert.ok(/^From: "H" <f@gmail.com>/m.test(html), 'From uses the account name, not DeliverIQ');
  const token = html.match(/\/t\/o\/([^".]+)\.gif/)?.[1];
  assert.ok(token, 'open pixel present');
  const parsed = parseTrackingToken(token);
  assert.equal(parsed.campaignId, fresh.id);
  assert.equal(parsed.stepId, c.currentStep.id);
  assert.ok(/\/t\/c\//.test(html), 'click tracking present');
  await cs.applyEngagementEvent({ campaignId: parsed.campaignId, recipientId: parsed.recipientId, stepId: parsed.stepId, event: 'open' });
  const after = (await cs.listCampaignsWithStats()).find((row) => row.id === fresh.id);
  assert.equal(after.totals.opened, 1);
  assert.equal(after.totals.sent, 2);

  // Reconcile is idempotent.
  assert.equal((await cs.reconcileCampaignSteps()).length, 0);
  await prisma.$disconnect();
});
