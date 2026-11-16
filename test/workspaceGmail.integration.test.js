// Runs only against a throwaway database: TEST_DATABASE_URL=postgresql://... npm test
// Never point this at production. It deletes all rows in the tables it uses.
//
// Gmail is connected per workspace, and every endpoint only shows the active workspace.
// Same login, two workspaces, two Gmail addresses: FinanceBridge keeps its Gmail, the
// personal workspace sends from its own, and nothing from one shows up in the other.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import dns from 'node:dns';

const url = process.env.TEST_DATABASE_URL;

function call(server, jar, method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = {};
    if (jar.cookie) headers.Cookie = jar.cookie;
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(payload.length);
    }
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path, headers }, async (res) => {
      const chunks = [];
      for await (const chunk of res) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString('utf8');
      const setCookie = res.headers['set-cookie']?.find((c) => c.startsWith('deliveriq_token='));
      if (setCookie) jar.cookie = setCookie.split(';')[0];
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        // not JSON
      }
      resolve({ status: res.statusCode, json, text, location: res.headers.location });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('Gmail per workspace and endpoint isolation', { skip: !url && 'TEST_DATABASE_URL not set', timeout: 120000 }, async () => {
  process.env.DATABASE_URL = url;
  process.env.NODE_ENV = 'production';
  process.env.APP_URL = 'http://127.0.0.1';
  process.env.SESSION_SECRET = 'test-secret';
  process.env.GOOGLE_CLIENT_ID = 'test-client';
  process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
  delete process.env.REDIS_URL;
  dns.resolveMx = (_domain, callback) => callback(null, [{ exchange: 'mx.example.com', priority: 10 }]);

  // Fake Gmail: record who each message was sent from.
  const { google } = await import('googleapis');
  const raws = [];
  google.gmail = () => ({
    users: { messages: { send: async ({ requestBody }) => { raws.push(Buffer.from(requestBody.raw, 'base64url').toString('utf8')); return { data: { id: `m${raws.length}`, threadId: `t${raws.length}` } }; } } },
  });
  const fromOf = (raw) => raw.split('\r\n').find((line) => line.startsWith('From:')) || '';

  const jwt = (await import('jsonwebtoken')).default;
  const { prisma } = await import('../src/lib/prisma.js');
  const { createApp } = await import('../src/app.js');
  const scheduler = await import('../src/services/sendScheduler.js');
  const cs = await import('../src/services/campaignService.js');
  const gmail = await import('../src/services/gmailService.js');
  const inbox = await import('../src/services/inboxSync.js');
  const hooks = { recordSend: cs.recordSend, recordBounce: cs.recordBounce, maybeCompleteCampaign: cs.maybeCompleteCampaign };

  for (const table of ['schedulerLease', 'inboundReply', 'campaignRecipient', 'campaignStep', 'campaign', 'recipient', 'contactList', 'template', 'invite', 'workspaceMember', 'user', 'gmailAccount', 'workspace']) {
    await prisma[table].deleteMany({});
  }

  const server = http.createServer(createApp());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const h = {};
  const j = {};
  const o = {};
  const api = (jar, method, path, body) => call(server, jar, method, path, body);
  const switchTo = async (jar, workspaceId) => {
    const res = await api(jar, 'POST', '/auth/workspaces/switch', { workspaceId });
    assert.equal(res.status, 200, res.text);
  };
  const exchangeAs = (email) => async () => ({ email, refreshToken: `refresh-${email}` });

  try {
    // Haitham: FinanceBridge, plus a personal workspace under the same login.
    let res = await api(h, 'POST', '/auth/register', { name: 'Haitham', email: 'h@fb.dev', password: 'password1', workspaceName: 'FinanceBridge' });
    assert.equal(res.status, 201, res.text);
    const fb = res.json.user.workspaceId;
    const haitham = await prisma.user.findUnique({ where: { email: 'h@fb.dev' } });
    await api(h, 'POST', '/recipients/lists', { name: 'FB Accountants' });
    const fbList = await prisma.contactList.findFirst({ where: { workspaceId: fb } });
    res = await api(h, 'POST', '/recipients', { email: 'fb.lead@client.dev', name: 'FB Lead', listId: fbList.id });
    assert.equal(res.status, 201, res.text);
    const fbLead = res.json;
    res = await api(h, 'POST', '/templates', { name: 'FB Pitch', subject: 'FB subject', body: '<p>FB body</p>' });
    assert.equal(res.status, 201, res.text);
    const fbTpl = res.json;
    const fbCampaign = await cs.createCampaign({ workspaceId: fb, name: 'FB Campaign', subject: 'S', templateId: fbTpl.id, scheduledAt: new Date(), recipientIds: [fbLead.id], listId: fbList.id, createdById: haitham.id });
    await prisma.campaignStep.updateMany({ where: { campaignId: fbCampaign.id }, data: { status: 'sending' } });

    res = await api(h, 'POST', '/auth/workspaces', { name: 'Personal' });
    assert.equal(res.status, 201, res.text);
    const personal = res.json.workspace.id;
    await api(h, 'POST', '/recipients/lists', { name: 'Personal Clients' });
    const pList = await prisma.contactList.findFirst({ where: { workspaceId: personal } });
    res = await api(h, 'POST', '/recipients', { email: 'p.lead@client.dev', name: 'P Lead', listId: pList.id });
    assert.equal(res.status, 201, res.text);
    const pLead = res.json;
    res = await api(h, 'POST', '/templates', { name: 'Personal Pitch', subject: 'P subject', body: '<p>P body</p>' });
    const pTpl = res.json;
    const pCampaign = await cs.createCampaign({ workspaceId: personal, name: 'Personal Campaign', subject: 'S', templateId: pTpl.id, scheduledAt: new Date(), recipientIds: [pLead.id], listId: pList.id, createdById: haitham.id });
    await prisma.campaignStep.updateMany({ where: { campaignId: pCampaign.id }, data: { status: 'sending' } });

    // 1. Connect Gmail is for the active workspace: the signed OAuth state carries it.
    res = await api(h, 'GET', '/auth/google');
    assert.equal(res.status, 302);
    const state = new URL(res.location).searchParams.get('state');
    const claims = jwt.verify(state, 'test-secret');
    assert.equal(claims.workspaceId, personal, 'state names the workspace that was open');
    assert.equal(claims.userId, haitham.id);
    assert.equal(claims.purpose, 'gmail_connect');
    // An old style state without a workspace is refused, before Google is called.
    const oldState = jwt.sign({ userId: haitham.id }, 'test-secret', { expiresIn: '10m' });
    res = await api({}, 'GET', `/auth/google/callback?code=x&state=${encodeURIComponent(oldState)}`);
    assert.equal(res.status, 400);

    // Connect FinanceBridge's Gmail. The personal workspace has none yet.
    await gmail.connectGmail({ userId: haitham.id, workspaceId: fb, code: 'c', exchange: exchangeAs('FinanceBridge.AI@gmail.com') });
    const fbAcct = await prisma.gmailAccount.findUnique({ where: { email: 'financebridge.ai@gmail.com' } });
    assert.ok(fbAcct, 'address stored lowercased');

    // 2. The personal workspace does not see or borrow FinanceBridge's Gmail (the leak).
    res = await api(h, 'GET', '/auth/me');
    assert.equal(res.json.user.workspaceId, personal);
    assert.equal(res.json.google.connected, false, 'personal workspace shows no Gmail');
    assert.ok(!res.text.includes('financebridge.ai@gmail.com'));
    res = await api(h, 'GET', '/sending/status');
    assert.deepEqual(res.json.senders, [], 'sending status lists no FinanceBridge sender');
    assert.ok(!res.text.includes('financebridge.ai@gmail.com'));
    assert.equal(await scheduler.resolveSender(haitham.id, personal), null, 'no sender, never borrowed');
    let r = await scheduler.sendOneForSender(await prisma.gmailAccount.findUnique({ where: { id: fbAcct.id } }), null, { hooks });
    assert.equal(r.campaignId, fbCampaign.id, 'FinanceBridge Gmail only sends FinanceBridge campaigns');
    r = await scheduler.sendOneForSender(await prisma.gmailAccount.update({ where: { id: fbAcct.id }, data: { nextSendAt: null } }), null, { hooks });
    assert.equal(r.sent, false, 'the personal campaign is not sent from FinanceBridge Gmail');
    assert.equal(raws.length, 1);
    assert.match(fromOf(raws[0]), /financebridge\.ai@gmail\.com/);
    assert.equal(await prisma.campaignRecipient.count({ where: { recipientId: pLead.id } }), 0);

    // 3. Connect the personal Gmail in the personal workspace. Each workspace shows its own.
    await gmail.connectGmail({ userId: haitham.id, workspaceId: personal, code: 'c', exchange: exchangeAs('hyphen-suit822@gmail.com') });
    const pAcct = await prisma.gmailAccount.findUnique({ where: { email: 'hyphen-suit822@gmail.com' } });
    res = await api(h, 'GET', '/auth/me');
    assert.equal(res.json.google.email, 'hyphen-suit822@gmail.com');
    res = await api(h, 'GET', '/sending/status');
    assert.deepEqual(res.json.senders.map((s) => s.email), ['hyphen-suit822@gmail.com']);
    assert.equal(res.json.senders[0].sentToday, 0, 'FinanceBridge sends are not counted here');
    await switchTo(h, fb);
    res = await api(h, 'GET', '/auth/me');
    assert.equal(res.json.google.email, 'financebridge.ai@gmail.com', 'FinanceBridge keeps its Gmail');
    res = await api(h, 'GET', '/sending/status');
    assert.deepEqual(res.json.senders.map((s) => s.email), ['financebridge.ai@gmail.com']);
    assert.equal(res.json.senders[0].sentToday, 1);

    r = await scheduler.sendOneForSender(await prisma.gmailAccount.findUnique({ where: { id: pAcct.id } }), null, { hooks });
    assert.equal(r.campaignId, pCampaign.id);
    assert.match(fromOf(raws[1]), /hyphen-suit822@gmail\.com/, 'personal campaign sent from the personal Gmail');
    const sends = await prisma.campaignRecipient.findMany({ select: { recipientId: true, senderAccountId: true, senderId: true } });
    assert.deepEqual(
      sends.map((s) => [s.recipientId, s.senderAccountId, s.senderId]).sort(),
      [[fbLead.id, fbAcct.id, haitham.id], [pLead.id, pAcct.id, haitham.id]].sort(),
      'each send records the Gmail account it used'
    );

    // 4. A Gmail linked in two workspaces shares one gap and one daily cap.
    res = await api(h, 'POST', '/auth/workspaces', { name: 'Shared' });
    const shared = res.json.workspace.id;
    await gmail.connectGmail({ userId: haitham.id, workspaceId: shared, code: 'c', exchange: exchangeAs('financebridge.ai@gmail.com') });
    assert.equal(await prisma.gmailAccount.count({ where: { email: 'financebridge.ai@gmail.com' } }), 1, 'one row per address');
    res = await api(h, 'GET', '/sending/status');
    assert.equal(res.json.senders[0].sentToday, 1, 'address total includes the FinanceBridge send');
    assert.equal(res.json.senders[0].sentTodayHere, 0);
    assert.equal(res.json.senders[0].sharedWithOtherWorkspaces, true);
    await prisma.workspace.update({ where: { id: shared }, data: { dailySendCap: 1 } });
    const sList = await prisma.contactList.create({ data: { workspaceId: shared, name: 'S' } });
    const sTpl = await prisma.template.create({ data: { workspaceId: shared, name: 'S', body: 'Hi' } });
    const sLead = await prisma.recipient.create({ data: { workspaceId: shared, listId: sList.id, email: 's@client.dev', name: 'S' } });
    const sCampaign = await cs.createCampaign({ workspaceId: shared, name: 'Shared Campaign', subject: 'S', templateId: sTpl.id, scheduledAt: new Date(), recipientIds: [sLead.id], listId: sList.id, createdById: haitham.id });
    await prisma.campaignStep.updateMany({ where: { campaignId: sCampaign.id }, data: { status: 'sending' } });
    r = await scheduler.sendOneForSender(await prisma.gmailAccount.update({ where: { id: fbAcct.id }, data: { nextSendAt: null } }), null, { hooks });
    assert.equal(r.sent, false);
    assert.equal(r.reason, 'daily_cap', 'the FinanceBridge send counts against the shared cap');
    // The gap is shared too: a send claims the slot for every workspace using the address.
    await prisma.workspace.update({ where: { id: shared }, data: { dailySendCap: 100 } });
    r = await scheduler.sendOneForSender(await prisma.gmailAccount.findUnique({ where: { id: fbAcct.id } }), null, { hooks });
    assert.equal(r.sent, true);
    const after = await prisma.gmailAccount.findUnique({ where: { id: fbAcct.id } });
    assert.ok(after.nextSendAt > new Date(), 'next send waits the gap for every workspace on this address');

    // 5. Disconnect in one workspace keeps the others.
    await gmail.disconnectGmail(haitham.id, shared);
    assert.equal((await gmail.gmailStatus(haitham.id, shared)).connected, false);
    assert.equal((await gmail.gmailStatus(haitham.id, fb)).email, 'financebridge.ai@gmail.com', 'FinanceBridge still connected');
    assert.notEqual((await prisma.gmailAccount.findUnique({ where: { id: fbAcct.id } })).refreshToken, null, 'token kept while used');
    await gmail.disconnectGmail(haitham.id, personal);
    assert.equal((await prisma.gmailAccount.findUnique({ where: { id: pAcct.id } })).refreshToken, null, 'unused token forgotten');
    assert.equal((await gmail.gmailStatus(haitham.id, fb)).connected, true);

    // 6. Jamila signs up: her own private workspace, nothing from anyone else.
    res = await api(j, 'POST', '/auth/register', { name: 'Jamila', email: 'j@biz.dev', password: 'jamila-pass', workspaceName: 'Jamila Biz' });
    assert.equal(res.status, 201, res.text);
    const jws = res.json.user.workspaceId;
    const jamila = await prisma.user.findUnique({ where: { email: 'j@biz.dev' } });
    await api(j, 'POST', '/recipients/lists', { name: 'Jamila Buyers' });
    const jList = await prisma.contactList.findFirst({ where: { workspaceId: jws } });
    res = await api(j, 'POST', '/recipients', { email: 'j.lead@client.dev', name: 'J Lead', listId: jList.id });
    const jLead = res.json;
    await assert.rejects(
      () => gmail.connectGmail({ userId: haitham.id, workspaceId: jws, code: 'c', exchange: exchangeAs('x@gmail.com') }),
      (err) => err.status === 403,
      'cannot connect Gmail for a workspace you are not in'
    );

    // 7. An existing user can be invited into another workspace.
    await switchTo(h, fb);
    res = await api(h, 'POST', '/auth/invites', { email: 'j@biz.dev' });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.json.existingAccount, true);
    const token = res.json.token;
    res = await api({}, 'GET', `/auth/invites/preview?token=${encodeURIComponent(token)}`);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.existingAccount, true);
    res = await api({}, 'POST', '/auth/accept-invite', { token, password: 'wrong-pass1' });
    assert.equal(res.status, 401, 'needs her existing password');
    res = await api(j, 'POST', '/auth/accept-invite', { token, password: 'jamila-pass' });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.user.workspaceId, fb);
    assert.equal(res.json.user.role, 'member');
    res = await api(j, 'GET', '/auth/workspaces');
    assert.deepEqual(res.json.workspaces.map((w) => w.name).sort(), ['FinanceBridge', 'Jamila Biz']);
    res = await api(j, 'GET', '/recipients');
    assert.deepEqual(res.json.map((p) => p.email), ['fb.lead@client.dev'], 'in FinanceBridge she sees FinanceBridge only');
    assert.equal((await prisma.user.findUnique({ where: { id: jamila.id } })).passwordHash, jamila.passwordHash, 'password unchanged');
    res = await api(h, 'POST', '/auth/invites', { email: 'j@biz.dev' });
    assert.equal(res.status, 409, 'already a member');
    await switchTo(j, jws);
    res = await api(j, 'GET', '/recipients');
    assert.deepEqual(res.json.map((p) => p.email), ['j.lead@client.dev'], 'her own business stays separate');
    res = await api(j, 'GET', '/auth/me');
    assert.equal(res.json.google.connected, false, 'her workspace has no Gmail until she connects one');

    // 8. Endpoint sweep: nothing from another workspace in any list or status endpoint.
    res = await api(o, 'POST', '/auth/register', { name: 'Other', email: 'o@other.dev', password: 'password1', workspaceName: 'Other Co' });
    assert.equal(res.status, 201, res.text);
    const markers = {
      [fb]: ['fb.lead@client.dev', 'FB Accountants', 'FB Pitch', 'FB Campaign', 'financebridge.ai@gmail.com'],
      [personal]: ['p.lead@client.dev', 'Personal Clients', 'Personal Pitch', 'Personal Campaign', 'hyphen-suit822@gmail.com'],
      [jws]: ['j.lead@client.dev', 'Jamila Buyers'],
    };
    const getPaths = ['/auth/me', '/auth/team', '/dashboard', '/campaigns', '/recipients', '/recipients/lists', '/templates', '/sending/status', '/sending/settings'];
    const sweep = async (jar, activeId, label) => {
      for (const path of getPaths) {
        const out = await api(jar, 'GET', path);
        assert.equal(out.status, 200, `${label} ${path}: ${out.text}`);
        for (const [wsId, words] of Object.entries(markers)) {
          if (wsId === activeId) continue;
          for (const word of words) assert.ok(!out.text.includes(word), `${label} ${path} leaks "${word}"`);
        }
      }
    };
    await switchTo(h, personal);
    await sweep(h, personal, 'Haitham in Personal');
    await switchTo(h, fb);
    await sweep(h, fb, 'Haitham in FinanceBridge');
    await sweep(j, jws, 'Jamila in her workspace');
    await sweep(o, null, 'New sign up');
    res = await api(o, 'GET', '/auth/workspaces');
    assert.deepEqual(res.json.workspaces.map((w) => w.name), ['Other Co']);

    // By id: another workspace's rows are not found and not changed.
    const byId = [
      ['GET', `/campaigns/${fbCampaign.id}/report`],
      ['GET', `/campaigns/${fbCampaign.id}/audience`],
      ['GET', `/campaigns/${fbCampaign.id}/bounces`],
      ['POST', `/campaigns/${fbCampaign.id}/send`],
      ['POST', `/campaigns/${fbCampaign.id}/pause`],
      ['POST', `/campaigns/${fbCampaign.id}/resume`],
      ['POST', `/campaigns/${fbCampaign.id}/test`, { email: 'me@x.dev' }],
      ['POST', `/campaigns/${fbCampaign.id}/follow-up`, { subject: 'F', templateId: fbTpl.id }],
      ['DELETE', `/campaigns/${fbCampaign.id}`],
      ['GET', `/templates/${fbTpl.id}`],
      ['PATCH', `/templates/${fbTpl.id}`, { name: 'Hacked' }],
      ['DELETE', `/templates/${fbTpl.id}`],
      ['PATCH', `/recipients/${fbLead.id}`, { listId: fbList.id }],
      ['DELETE', `/recipients/${fbLead.id}`],
      ['GET', `/recipients/lists/${fbList.id}/delete-preview`],
      ['DELETE', `/recipients/lists/${fbList.id}?mode=list`],
      ['POST', '/sending/resume', { accountId: fbAcct.id }],
    ];
    for (const [method, path, body] of byId) {
      const out = await api(o, method, path, body);
      assert.ok(out.status >= 400 && out.status < 500, `${method} ${path} from another workspace returned ${out.status}`);
      for (const word of markers[fb]) assert.ok(!out.text.includes(word), `${method} ${path} leaks "${word}"`);
    }
    assert.ok(await prisma.campaign.findUnique({ where: { id: fbCampaign.id } }));
    assert.equal((await prisma.template.findUnique({ where: { id: fbTpl.id } })).name, 'FB Pitch');
    assert.ok(await prisma.recipient.findUnique({ where: { id: fbLead.id } }));
    assert.ok(await prisma.contactList.findUnique({ where: { id: fbList.id } }));

    // The tick only reports this workspace's sends.
    await prisma.gmailAccount.update({ where: { id: fbAcct.id }, data: { nextSendAt: null } });
    const fb2 = await prisma.recipient.create({ data: { workspaceId: fb, listId: fbList.id, email: 'fb2@client.dev', name: 'FB 2' } });
    const fbCampaign2 = await cs.createCampaign({ workspaceId: fb, name: 'FB Two', subject: 'S', templateId: fbTpl.id, scheduledAt: new Date(), recipientIds: [fb2.id], listId: fbList.id, createdById: haitham.id });
    await prisma.campaignStep.updateMany({ where: { campaignId: fbCampaign2.id }, data: { status: 'sending' } });
    const before = raws.length;
    res = await api(o, 'POST', '/sending/tick');
    assert.equal(res.status, 200, res.text);
    assert.equal(raws.length, before + 1, 'the FinanceBridge send went out');
    assert.equal(res.json.sent, 0, 'but another workspace is not told about it');

    // 9. Bounce and reply sync from a shared Gmail only report the asking workspace.
    await gmail.connectGmail({ userId: haitham.id, workspaceId: shared, code: 'c', exchange: exchangeAs('financebridge.ai@gmail.com') });
    const called = [];
    const result = await inbox.syncAllInboxes({
      force: true,
      workspaceId: shared,
      fetchDelta: async () => ({
        messages: [
          { id: 'b1', isBounce: true, subject: 'Delivery Status Notification (Failure)', fullText: 'Address not found. Your message wasn\'t delivered to fb.lead@client.dev because the address couldn\'t be found.' },
          { id: 'r1', isBounce: false, fromEmail: 'someone@client.dev', subject: 'Re: S' },
        ],
        historyId: '1',
        senderEmail: 'financebridge.ai@gmail.com',
      }),
      applyBounces: async () => (called.push('bounces'), { marked: 2, emails: ['fb.lead@client.dev', 's@client.dev'], marks: [{ email: 'fb.lead@client.dev', workspaceId: fb }, { email: 's@client.dev', workspaceId: shared }] }),
      applyReplies: async () => (called.push('replies'), { scanned: 3, replies: 3, autoReplies: 0, optOuts: 0, byWorkspace: { [fb]: { replies: 2, autoReplies: 0, optOuts: 0 }, [shared]: { replies: 1, autoReplies: 0, optOuts: 0 } } }),
    });
    assert.deepEqual(called, ['bounces', 'replies']);
    assert.deepEqual(result.bouncedEmails, ['s@client.dev'], 'FinanceBridge bounce not reported in Shared');
    assert.equal(result.bouncesMarked, 1);
    assert.equal(result.replies.replies, 1, 'FinanceBridge replies not counted in Shared');

    // Real bounce marking: a bounce in FinanceBridge Gmail never touches Jamila's contact with the same email.
    const jSame = await prisma.recipient.create({ data: { workspaceId: jws, listId: jList.id, email: 'fb.lead@client.dev', name: 'Same' } });
    const marked = await cs.applyBounceNotices([{ email: 'fb.lead@client.dev', reason: 'No such user' }], await prisma.gmailAccount.findUnique({ where: { id: fbAcct.id } }));
    assert.deepEqual(marked.marks.map((m) => m.workspaceId), [fb]);
    assert.equal((await prisma.recipient.findUnique({ where: { id: fbLead.id } })).status, 'bounced');
    assert.equal((await prisma.recipient.findUnique({ where: { id: jSame.id } })).status, 'active', 'other workspace untouched');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await prisma.$disconnect();
  }
});
