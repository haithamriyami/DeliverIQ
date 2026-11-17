// Runs only against a throwaway database: TEST_DATABASE_URL=postgresql://... npm test
// Never point this at production. It deletes all rows in the tables it uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';

const url = process.env.TEST_DATABASE_URL;

test(
  'CSV import stores organization or company and merge preview fills it',
  { skip: !url && 'TEST_DATABASE_URL not set' },
  async () => {
    process.env.DATABASE_URL = url;
    process.env.NODE_ENV = 'production';
    process.env.APP_URL = 'http://127.0.0.1';
    delete process.env.REDIS_URL;

    dns.resolveMx = (domain, callback) => {
      callback(null, [{ exchange: 'mx.example.com', priority: 10 }]);
    };

    const { prisma } = await import('../src/lib/prisma.js');
    const { importRecipientsFromCsv } = await import('../src/services/recipientService.js');
    const { renderMergePreview } = await import('../src/services/emailService.js');

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

    const ws = await prisma.workspace.create({ data: { name: 'ReportCopilot' } });
    const list = await prisma.contactList.create({ data: { workspaceId: ws.id, name: 'Universities (Kenya)' } });

    const csv = [
      'email,name,organization,timezone,notes',
      'louise@cottarsafaris.com,Louise Cottar,"Cottar\'s Safaris",Africa/Nairobi,"named; CEO, Cottar\'s Safaris; Hospitality; Kenya; source https://cottars.com"',
      'sotiriou.s@unic.ac.cy,Stathis Sotiriou,,Asia/Nicosia,named; EHS Officer; Universities; Cyprus',
    ].join('\n');

    const companyCsv = [
      'email,full_name,company,country',
      'anna@sodexo.com,Anna Burholm,Sodexo,Sweden',
    ].join('\n');

    const first = await importRecipientsFromCsv(csv, list.id, { workspaceId: ws.id, autoSort: false });
    assert.equal(first.created, 2);
    const second = await importRecipientsFromCsv(companyCsv, list.id, { workspaceId: ws.id, autoSort: false });
    assert.equal(second.created, 1);

    const louise = await prisma.recipient.findFirst({ where: { workspaceId: ws.id, email: 'louise@cottarsafaris.com' } });
    const stathis = await prisma.recipient.findFirst({ where: { workspaceId: ws.id, email: 'sotiriou.s@unic.ac.cy' } });
    const anna = await prisma.recipient.findFirst({ where: { workspaceId: ws.id, email: 'anna@sodexo.com' } });
    assert.equal(louise.organization, "Cottar's Safaris");
    assert.equal(stathis.organization, null);
    assert.equal(anna.organization, 'Sodexo');

    const filled = renderMergePreview({
      body: 'Hi {{name}}, I am offering a free 2 week pilot for {{organization}}.',
      name: louise.name,
      organization: louise.organization,
      email: louise.email,
    });
    assert.equal(
      filled.body,
      "Hi Louise Cottar, I am offering a free 2 week pilot for Cottar's Safaris."
    );

    const fallback = renderMergePreview({
      body: 'Hi {{name}}, I am offering a free 2 week pilot for {{organization}}.',
      name: stathis.name,
      organization: stathis.organization,
      email: stathis.email,
    });
    assert.equal(
      fallback.body,
      'Hi Stathis Sotiriou, I am offering a free 2 week pilot for your organization.'
    );
  }
);
