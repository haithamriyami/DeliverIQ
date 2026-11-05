// Runs only against a throwaway database: TEST_DATABASE_URL=postgresql://... npm test
// Never point this at production. It deletes all rows in the tables it uses.
import test from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;

test('CSV auto-sort creates country sector lists and reports a per-list summary', { skip: !url && 'TEST_DATABASE_URL not set' }, async () => {
  process.env.DATABASE_URL = url;
  process.env.NODE_ENV = 'production';
  delete process.env.REDIS_URL;
  const { prisma } = await import('../src/lib/prisma.js');
  const rs = await import('../src/services/recipientService.js');

  for (const table of [
    'schedulerLease',
    'inboundReply',
    'campaignRecipient',
    'campaignStep',
    'campaign',
    'recipient',
    'contactList',
    'template',
    'user',
    'workspace',
  ]) {
    await prisma[table].deleteMany({});
  }

  const agencies = await prisma.contactList.create({ data: { name: 'Agencies' } });
  await prisma.contactList.create({ data: { name: 'Restaurants' } });

  const csv = [
    'email,name,timezone,notes',
    'a1@example.com,Ann,South Africa,named | agency | South Africa | https://a.test',
    'a2@example.com,Bob,South Africa,named | agency | South Africa | https://b.test',
    'b1@example.com,Cara,Canada,named | beauty | Canada | https://c.test',
    'b2@example.com,Dan,Canada,named | beauty | Canada | https://d.test',
    'u1@example.com,Eve,United Kingdom,named | agency | United Kingdom | https://e.test',
    'x1@example.com,NoSector,South Africa,just a freeform note',
    'bad-email,Bad,South Africa,named | agency | South Africa | https://f.test',
  ].join('\n');

  const alwaysOk = async () => ({ valid: true });
  const summary = await rs.importRecipientsFromCsv(csv, agencies.id, {
    autoSort: true,
    checkDomain: alwaysOk,
  });

  assert.equal(summary.created, 6);
  assert.equal(summary.skippedInvalid, 1);
  assert.deepEqual(summary.byList, {
    'Agencies (South Africa)': 2,
    'Salons & Barbers (Canada)': 2,
    'Agencies (United Kingdom)': 1,
    Agencies: 1, // no sector -> selected fallback list
  });

  const names = (await prisma.contactList.findMany({ orderBy: { name: 'asc' } })).map((l) => l.name);
  assert.ok(names.includes('Agencies (South Africa)'));
  assert.ok(names.includes('Salons & Barbers (Canada)'));
  assert.ok(names.includes('Agencies (United Kingdom)'));

  const a1 = await prisma.recipient.findUnique({
    where: { email: 'a1@example.com' },
    include: { list: true },
  });
  assert.equal(a1.list.name, 'Agencies (South Africa)');

  const x1 = await prisma.recipient.findUnique({
    where: { email: 'x1@example.com' },
    include: { list: true },
  });
  assert.equal(x1.list.name, 'Agencies');

  // Default (no autoSort option) still auto-sorts.
  const defaultCsv = [
    'email,name,timezone,notes',
    'def1@example.com,Default,Canada,named | agency | Canada | https://def.test',
  ].join('\n');
  const defSummary = await rs.importRecipientsFromCsv(defaultCsv, agencies.id, {
    checkDomain: alwaysOk,
  });
  assert.equal(defSummary.autoSort, true);
  assert.equal(defSummary.byList['Agencies (Canada)'], 1);

  // Off path: autoSort false dumps everything into the selected list.
  const plainCsv = [
    'email,name,timezone,notes',
    'plain1@example.com,Pat,Canada,named | beauty | Canada | https://p.test',
  ].join('\n');
  const plain = await rs.importRecipientsFromCsv(plainCsv, agencies.id, {
    autoSort: false,
    checkDomain: alwaysOk,
  });
  assert.equal(plain.created, 1);
  assert.deepEqual(plain.byList, { Agencies: 1 });
  const plainRow = await prisma.recipient.findUnique({
    where: { email: 'plain1@example.com' },
    include: { list: true },
  });
  assert.equal(plainRow.list.name, 'Agencies');

  // Re-import into an already filled target list updates that contact.
  const again = await rs.importRecipientsFromCsv(
    'email,name,timezone,notes\na1@example.com,Ann Updated,South Africa,named | agency | South Africa | https://a.test',
    agencies.id,
    { autoSort: true, checkDomain: alwaysOk }
  );
  assert.equal(again.updated, 1);
  assert.equal((await prisma.recipient.findUnique({ where: { email: 'a1@example.com' } })).name, 'Ann Updated');

  await prisma.$disconnect();
});
