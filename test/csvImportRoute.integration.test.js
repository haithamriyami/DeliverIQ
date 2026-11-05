// Runs only against a throwaway database: TEST_DATABASE_URL=postgresql://... npm test
// Never point this at production. It deletes all rows in the tables it uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import dns from 'node:dns';
import { signUserToken } from '../src/middleware/auth.js';

const url = process.env.TEST_DATABASE_URL;

async function readBody(res) {
  const chunks = [];
  for await (const chunk of res) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return { status: res.statusCode, json: JSON.parse(text), text };
  } catch {
    return { status: res.statusCode, json: null, text };
  }
}

function request(server, { method, path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.address().port,
        method,
        path,
        headers,
      },
      (res) => readBody(res).then(resolve, reject)
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function multipart({ fields, file }) {
  const boundary = '----DeliverIQTestBoundary7MA4YWxkTrZu0gW';
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
    );
  }
  if (file) {
    chunks.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: text/csv\r\n\r\n${file.content}\r\n`
    );
  }
  chunks.push(`--${boundary}--\r\n`);
  return {
    body: Buffer.from(chunks.join(''), 'utf8'),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

test(
  'HTTP import route auto-sorts for multipart, JSON, and missing autoSort (regression)',
  { skip: !url && 'TEST_DATABASE_URL not set' },
  async () => {
    process.env.DATABASE_URL = url;
    process.env.NODE_ENV = 'production';
    process.env.APP_URL = 'http://127.0.0.1';
    delete process.env.REDIS_URL;

    // Stub MX lookup before the app loads emailValidation's promisify wrapper.
    dns.resolveMx = (domain, callback) => {
      callback(null, [{ exchange: 'mx.example.com', priority: 10 }]);
    };

    const { prisma } = await import('../src/lib/prisma.js');
    const { createApp } = await import('../src/app.js');

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

    const ws = await prisma.workspace.create({ data: { name: 'W' } });
    const user = await prisma.user.create({
      data: {
        email: 'owner@import.test',
        name: 'Owner',
        passwordHash: 'x',
        role: 'owner',
        workspaceId: ws.id,
      },
    });
    const agencies = await prisma.contactList.create({ data: { name: 'Agencies' } });
    await prisma.contactList.create({ data: { name: 'Beauty salons' } });

    const app = createApp();
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const cookie = `deliveriq_token=${signUserToken(user)}`;

    const csvA = [
      'email,name,timezone,notes',
      'uk1@example.com,Ann,United Kingdom,named | agency | United Kingdom | https://a.test',
      'uae1@example.com,Bob,UTC,named | agency | United Arab Emirates | https://b.test',
      'beauty1@example.com,Cara,United Kingdom,named | beauty | United Kingdom | https://c.test',
    ].join('\n');

    // Exact browser multipart payload shape (file + listId + autoSort=true).
    const mp = multipart({
      fields: { listId: agencies.id, autoSort: 'true' },
      file: { field: 'file', filename: 'batch.csv', content: csvA },
    });
    let res = await request(server, {
      method: 'POST',
      path: '/recipients/import',
      headers: {
        Cookie: cookie,
        'Content-Type': mp.contentType,
        'Content-Length': String(mp.body.length),
      },
      body: mp.body,
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.autoSort, true);
    assert.equal(res.json.created, 3);
    assert.deepEqual(res.json.byList, {
      'Agencies (United Arab Emirates)': 1,
      'Agencies (United Kingdom)': 1,
      'Salons & Barbers (United Kingdom)': 1,
    });

    await prisma.recipient.deleteMany({});

    // JSON / pasted CSV path with boolean autoSort.
    const csvB = [
      'email,name,timezone,notes',
      'uk2@example.com,Dee,United Kingdom,named | agency | United Kingdom | https://d.test',
    ].join('\n');
    res = await request(server, {
      method: 'POST',
      path: '/recipients/import',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ csv: csvB, listId: agencies.id, autoSort: true }),
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.autoSort, true);
    assert.equal(res.json.byList['Agencies (United Kingdom)'], 1);

    await prisma.recipient.deleteMany({});

    // REGRESSION: multipart with NO autoSort field (stale app.js). Must still auto-sort.
    const csvC = [
      'email,name,timezone,notes',
      'uk3@example.com,Eve,United Kingdom,named | agency | United Kingdom | https://e.test',
      'beauty2@example.com,Fay,United Kingdom,named | beauty | United Kingdom | https://f.test',
    ].join('\n');
    const mpMissing = multipart({
      fields: { listId: agencies.id },
      file: { field: 'file', filename: 'stale.csv', content: csvC },
    });
    res = await request(server, {
      method: 'POST',
      path: '/recipients/import',
      headers: {
        Cookie: cookie,
        'Content-Type': mpMissing.contentType,
        'Content-Length': String(mpMissing.body.length),
      },
      body: mpMissing.body,
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.autoSort, true, 'missing autoSort must default to on');
    assert.deepEqual(res.json.byList, {
      'Agencies (United Kingdom)': 1,
      'Salons & Barbers (United Kingdom)': 1,
    });
    const dumped = await prisma.recipient.count({
      where: { list: { name: { in: ['Agencies', 'Beauty salons'] } } },
    });
    assert.equal(dumped, 0, 'must not dump into plain Agencies or Beauty salons');

    await prisma.recipient.deleteMany({});

    // Explicit off still falls back to the selected list.
    const csvD = [
      'email,name,timezone,notes',
      'plain@example.com,Gus,United Kingdom,named | beauty | United Kingdom | https://g.test',
    ].join('\n');
    const mpOff = multipart({
      fields: { listId: agencies.id, autoSort: 'false' },
      file: { field: 'file', filename: 'off.csv', content: csvD },
    });
    res = await request(server, {
      method: 'POST',
      path: '/recipients/import',
      headers: {
        Cookie: cookie,
        'Content-Type': mpOff.contentType,
        'Content-Length': String(mpOff.body.length),
      },
      body: mpOff.body,
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.autoSort, false);
    assert.deepEqual(res.json.byList, { Agencies: 1 });

    // When body omits autoSort, query string still enables it.
    await prisma.recipient.deleteMany({});
    const mpQueryOnly = multipart({
      fields: { listId: agencies.id },
      file: {
        field: 'file',
        filename: 'q2.csv',
        content: csvD.replace('plain@', 'plain3@'),
      },
    });
    res = await request(server, {
      method: 'POST',
      path: '/recipients/import?autoSort=true',
      headers: {
        Cookie: cookie,
        'Content-Type': mpQueryOnly.contentType,
        'Content-Length': String(mpQueryOnly.body.length),
      },
      body: mpQueryOnly.body,
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.autoSort, true);
    assert.equal(res.json.byList['Salons & Barbers (United Kingdom)'], 1);

    server.close();
    await prisma.$disconnect();
  }
);
