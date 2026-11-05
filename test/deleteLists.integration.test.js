// Runs only against a throwaway database: TEST_DATABASE_URL=postgresql://... npm test
// Never point this at production. It deletes all rows in the tables it uses.
import test from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;

test('deleting lists keeps campaign contacts and suppression records', { skip: !url && 'TEST_DATABASE_URL not set' }, async () => {
  process.env.DATABASE_URL = url;
  process.env.NODE_ENV = 'production';
  delete process.env.REDIS_URL;
  const { prisma } = await import('../src/lib/prisma.js');
  const rs = await import('../src/services/recipientService.js');
  const cs = await import('../src/services/campaignService.js');

  for (const table of ['schedulerLease', 'inboundReply', 'campaignRecipient', 'campaignStep', 'campaign', 'recipient', 'contactList', 'template', 'user', 'workspace']) {
    await prisma[table].deleteMany({});
  }
  const ws = await prisma.workspace.create({ data: { name: 'W' } });
  const user = await prisma.user.create({ data: { email: 'o@t.dev', name: 'H', passwordHash: 'x', role: 'owner', workspaceId: ws.id } });
  const tpl = await prisma.template.create({ data: { name: 'T', body: '<p>Hi</p>' } });
  const mkList = (name) => prisma.contactList.create({ data: { name } });
  const mk = (email, listId, extra = {}) => prisma.recipient.create({ data: { email, name: 'P', listId, ...extra } });

  // Empty list: deleted straight away.
  const empty = await mkList('Hospitality');
  const r0 = await rs.deleteContactList(empty.id);
  assert.equal(r0.deleted, true);
  assert.equal(await prisma.contactList.count({ where: { id: empty.id } }), 0);

  // Keep contacts: they move to Unassigned.
  const keepList = await mkList('Retails');
  await mk('a@x.dev', keepList.id);
  await mk('b@x.dev', keepList.id);
  const r1 = await rs.deleteContactList(keepList.id, { mode: 'list' });
  assert.equal(r1.contactsMoved, 2);
  assert.equal(r1.contactsDeleted, 0);
  const unassigned = await prisma.contactList.findFirst({ where: { name: 'Unassigned' } });
  assert.ok(unassigned);
  assert.equal(await prisma.recipient.count({ where: { listId: unassigned.id } }), 2);

  // Delete contacts: plain ones go, campaign and suppressed ones stay (moved to Unassigned).
  const big = await mkList('Bakery/bakers');
  const plain = await mk('plain@x.dev', big.id);
  const queued = await mk('queued@x.dev', big.id);
  const bounced = await mk('bounced@x.dev', big.id, { status: 'bounced' });
  const unsub = await mk('unsub@x.dev', big.id, { status: 'unsubscribed' });
  const dnc = await mk('dnc@x.dev', big.id, { doNotContact: true });
  const campaign = await cs.createCampaign({ name: 'C', subject: 'S', templateId: tpl.id, scheduledAt: new Date(), recipientIds: [queued.id], listId: big.id, createdById: user.id });
  await prisma.campaignStep.updateMany({ where: { campaignId: campaign.id }, data: { status: 'sending' } });

  const preview = await rs.previewListDeletion(big.id);
  assert.deepEqual(
    { total: preview.total, inActiveCampaigns: preview.inActiveCampaigns, suppressed: preview.suppressed, deletable: preview.deletable },
    { total: 5, inActiveCampaigns: 1, suppressed: 3, deletable: 1 }
  );

  const r2 = await rs.deleteContactList(big.id, { mode: 'contacts' });
  assert.equal(r2.contactsDeleted, 1);
  assert.equal(r2.contactsMoved, 4);
  assert.equal(await prisma.recipient.count({ where: { id: plain.id } }), 0);
  for (const kept of [queued, bounced, unsub, dnc]) {
    const row = await prisma.recipient.findUnique({ where: { id: kept.id } });
    assert.ok(row, `${kept.email} kept`);
    assert.equal(row.listId, unassigned.id);
  }
  // Suppression still holds after the move.
  assert.equal((await prisma.recipient.findUnique({ where: { id: bounced.id } })).status, 'bounced');
  assert.equal((await prisma.recipient.findUnique({ where: { id: dnc.id } })).doNotContact, true);
  // The campaign still has its queued contact.
  const after = await prisma.campaign.findUnique({ where: { id: campaign.id } });
  assert.ok(after.recipientIds.includes(queued.id));
  assert.equal(after.listId, null);

  // Unassigned with protected contacts cannot be removed.
  await assert.rejects(() => rs.deleteContactList(unassigned.id, { mode: 'contacts' }), /cannot be removed/);

  // Bulk: only empty lists go, never the last list.
  await mkList('E-commerce');
  await mkList('real estate');
  const withPeople = await mkList('Agencies');
  await mk('ag@x.dev', withPeople.id);
  const bulk = await rs.deleteEmptyLists();
  assert.equal(bulk.deleted, 2);
  assert.ok(await prisma.contactList.findUnique({ where: { id: withPeople.id } }));
  await prisma.recipient.deleteMany({});
  await prisma.campaign.deleteMany({});
  const last = await rs.deleteEmptyLists();
  assert.equal(await prisma.contactList.count(), 1, 'last list kept');
  assert.ok(last.deleted >= 1);

  await prisma.$disconnect();
});
