// Runs only against a throwaway database: TEST_DATABASE_URL=postgresql://... npm test
// Never point this at production. It deletes all rows in the tables it uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import dns from 'node:dns';

const url = process.env.TEST_DATABASE_URL;

function call(server, cookieJar, method, path, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { ...extraHeaders };
    if (cookieJar.cookie) headers.Cookie = cookieJar.cookie;
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(payload.length);
    }
    const req = http.request(
      { host: '127.0.0.1', port: server.address().port, method, path, headers },
      async (res) => {
        const chunks = [];
        for await (const chunk of res) chunks.push(chunk);
        const text = Buffer.concat(chunks).toString('utf8');
        const setCookie = res.headers['set-cookie']?.find((c) => c.startsWith('deliveriq_token='));
        if (setCookie) cookieJar.cookie = setCookie.split(';')[0];
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          // not JSON
        }
        resolve({ status: res.statusCode, json, text });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('workspaces keep contacts, lists, templates and campaigns apart', { skip: !url && 'TEST_DATABASE_URL not set', timeout: 120000 }, async () => {
  process.env.DATABASE_URL = url;
  process.env.NODE_ENV = 'production';
  process.env.APP_URL = 'http://127.0.0.1';
  delete process.env.REDIS_URL;
  dns.resolveMx = (_domain, callback) => callback(null, [{ exchange: 'mx.example.com', priority: 10 }]);

  const { prisma } = await import('../src/lib/prisma.js');
  const { createApp } = await import('../src/app.js');
  const scheduler = await import('../src/services/sendScheduler.js');
  const cs = await import('../src/services/campaignService.js');
  const rs = await import('../src/services/recipientService.js');

  for (const table of ['schedulerLease', 'inboundReply', 'campaignRecipient', 'campaignStep', 'campaign', 'recipient', 'contactList', 'template', 'invite', 'workspaceMember', 'user', 'gmailAccount', 'workspace']) {
    await prisma[table].deleteMany({});
  }

  const server = http.createServer(createApp());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const a = {};
  const b = {};
  const api = (jar, method, path, body, headers) => call(server, jar, method, path, body, headers);

  try {
    // 1. Every sign up gets its own workspace. The second person no longer joins the first.
    let res = await api(a, 'POST', '/auth/register', { name: 'Haitham', email: 'h@fb.dev', password: 'password1', workspaceName: 'FinanceBridge' });
    assert.equal(res.status, 201, res.text);
    const wsA = res.json.user.workspaceId;
    assert.equal(res.json.user.role, 'owner');
    res = await api(b, 'POST', '/auth/register', { name: 'Other', email: 'o@other.dev', password: 'password1', workspaceName: 'Other' });
    assert.equal(res.status, 201, res.text);
    const wsB = res.json.user.workspaceId;
    assert.notEqual(wsA, wsB);
    assert.equal(res.json.user.role, 'owner', 'a new sign up owns their own workspace');

    // 2. Workspace A data.
    res = await api(a, 'POST', '/recipients/lists', { name: 'Accountants (Kenya)' });
    assert.equal(res.status, 201, res.text);
    const listA = res.json;
    res = await api(a, 'POST', '/recipients', { email: 'shared@client.dev', name: 'Shared', listId: listA.id });
    assert.equal(res.status, 201, res.text);
    const personA = res.json;
    res = await api(a, 'POST', '/templates', { name: 'FB | Hello', body: 'Hi there' });
    const templateA = res.json;
    res = await api(a, 'POST', '/campaigns', { name: 'FB campaign', subject: 'S', templateId: templateA.id, scheduledAt: new Date().toISOString(), recipientIds: [personA.id], listId: listA.id });
    assert.equal(res.status, 201, res.text);
    const campaignA = res.json;
    assert.equal(campaignA.workspaceId, wsA);

    // 3. Workspace B cannot see any of it.
    assert.deepEqual((await api(b, 'GET', '/recipients')).json, []);
    assert.ok(!(await api(b, 'GET', '/recipients/lists')).json.some((l) => l.id === listA.id));
    assert.deepEqual((await api(b, 'GET', '/templates')).json, []);
    assert.deepEqual((await api(b, 'GET', '/campaigns')).json, []);
    const dashB = (await api(b, 'GET', '/dashboard')).json;
    assert.equal(dashB.kpis.totalCampaigns, 0);
    assert.equal((await api(b, 'GET', `/recipients?listId=${listA.id}`)).json.length, 0);

    // 4. ...and cannot change any of it.
    const notFound = async (method, path, body) => {
      const r = await api(b, method, path, body);
      assert.ok([400, 404].includes(r.status), `${method} ${path} gave ${r.status}: ${r.text}`);
    };
    await notFound('GET', `/templates/${templateA.id}`);
    await notFound('PATCH', `/templates/${templateA.id}`, { name: 'hacked' });
    await notFound('DELETE', `/templates/${templateA.id}`);
    await notFound('DELETE', `/recipients/${personA.id}`);
    await notFound('GET', `/recipients/lists/${listA.id}/delete-preview`);
    await notFound('DELETE', `/recipients/lists/${listA.id}?mode=contacts`);
    await notFound('GET', `/campaigns/${campaignA.id}/report`);
    await notFound('GET', `/campaigns/${campaignA.id}/audience`);
    await notFound('POST', `/campaigns/${campaignA.id}/send`, {});
    await notFound('POST', `/campaigns/${campaignA.id}/test`, { email: 'x@y.dev' });
    await notFound('POST', `/campaigns/${campaignA.id}/pause`);
    await notFound('POST', `/campaigns/${campaignA.id}/resume`);
    await notFound('POST', `/campaigns/${campaignA.id}/follow-up`, { subject: 'F', templateId: templateA.id });
    await notFound('DELETE', `/campaigns/${campaignA.id}`);
    await notFound('POST', '/recipients/import', { csv: 'email,name\nnew@x.dev,N', listId: listA.id });

    // B's list, then try to use A's things from B's workspace.
    res = await api(b, 'POST', '/recipients/lists', { name: 'Accountants (Kenya)' });
    assert.equal(res.status, 201, 'the same list name is fine in another workspace');
    const listB = res.json;
    await notFound('PATCH', `/recipients/${personA.id}`, { listId: listB.id });
    res = await api(b, 'POST', '/templates', { name: 'Other | Hi', body: 'Hi' });
    const templateB = res.json;
    await notFound('POST', '/campaigns', { name: 'Steal', subject: 'S', templateId: templateB.id, scheduledAt: new Date().toISOString(), recipientIds: [personA.id] });
    await notFound('POST', '/campaigns', { name: 'Steal', subject: 'S', templateId: templateA.id, scheduledAt: new Date().toISOString(), recipientIds: [personA.id] });

    // Nothing in A changed.
    assert.equal((await prisma.template.findUnique({ where: { id: templateA.id } })).name, 'FB | Hello');
    assert.ok(await prisma.recipient.findUnique({ where: { id: personA.id } }));
    assert.ok(await prisma.campaign.findUnique({ where: { id: campaignA.id } }));
    assert.equal((await prisma.campaign.findUnique({ where: { id: campaignA.id } })).pausedAt, null);

    // 5. The same email can exist in both workspaces, and unsubscribing is per workspace.
    res = await api(b, 'POST', '/recipients', { email: 'shared@client.dev', name: 'Shared', listId: listB.id });
    assert.equal(res.status, 201, res.text);
    const personB = res.json;
    assert.notEqual(personB.id, personA.id);
    res = await api(b, 'POST', '/recipients/import', { csv: 'email,name\nshared@client.dev,Shared again', listId: listB.id, autoSort: false });
    assert.equal(res.json.updated, 1, 'import matches the contact in this workspace only');
    assert.equal(await prisma.recipient.count({ where: { email: 'shared@client.dev' } }), 2);
    const tokenB = (await prisma.recipient.findUnique({ where: { id: personB.id } })).unsubscribeToken;
    res = await api({}, 'POST', '/unsubscribe', { token: tokenB });
    assert.equal(res.status, 200, res.text);
    assert.equal((await prisma.recipient.findUnique({ where: { id: personB.id } })).status, 'unsubscribed');
    assert.equal((await prisma.recipient.findUnique({ where: { id: personA.id } })).status, 'active');

    // 6. Switching: create a second workspace for A, it starts empty, then switch back.
    res = await api(a, 'POST', '/auth/workspaces', { name: 'Fiverr clients' });
    assert.equal(res.status, 201, res.text);
    const wsA2 = res.json.workspace.id;
    assert.equal(res.json.user.workspaceId, wsA2);
    assert.deepEqual((await api(a, 'GET', '/recipients')).json, []);
    assert.deepEqual((await api(a, 'GET', '/templates')).json, []);
    assert.deepEqual((await api(a, 'GET', '/campaigns')).json, []);
    res = await api(a, 'GET', '/auth/workspaces');
    assert.deepEqual(res.json.workspaces.map((w) => w.name), ['FinanceBridge', 'Fiverr clients']);
    assert.equal(res.json.activeWorkspaceId, wsA2);
    assert.equal((await api(a, 'POST', '/auth/workspaces/switch', { workspaceId: wsB })).status, 404, 'cannot switch into a workspace you are not in');
    res = await api(a, 'POST', '/auth/workspaces/switch', { workspaceId: wsA });
    assert.equal(res.status, 200, res.text);
    assert.equal((await api(a, 'GET', '/recipients')).json.length, 1);
    assert.equal((await api(a, 'GET', '/auth/me')).json.user.workspaceId, wsA);

    // A page still showing another workspace (switched in another tab) is refused.
    res = await api(a, 'POST', '/templates', { name: 'Wrong tab', body: 'x' }, { 'X-Workspace-Id': wsA2 });
    assert.equal(res.status, 409);
    assert.equal(await prisma.template.count({ where: { name: 'Wrong tab' } }), 0);

    // 7. Invites still join the inviter's workspace, with a per workspace role.
    res = await api(a, 'POST', '/auth/invites', { email: 'helper@fb.dev' });
    assert.equal(res.status, 201, res.text);
    const helper = {};
    res = await api(helper, 'POST', '/auth/accept-invite', { token: res.json.token, name: 'Helper', password: 'password1' });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.user.workspaceId, wsA);
    assert.equal(res.json.user.role, 'member');
    assert.equal((await api(helper, 'GET', '/recipients')).json.length, 1);
    const team = (await api(a, 'GET', '/auth/team')).json;
    assert.deepEqual(team.users.map((u) => [u.email, u.role]), [['h@fb.dev', 'owner'], ['helper@fb.dev', 'member']]);
    // A is owner of FinanceBridge but the helper is only a member there: owner actions refused.
    assert.equal((await api(helper, 'DELETE', `/recipients/lists/${listA.id}?mode=list`)).status, 403);

    // 8. Sending: the same Gmail address linked in two workspaces. The gap and the daily
    //    count are shared per address.
    const userA = await prisma.user.findUnique({ where: { email: 'h@fb.dev' } });
    const { linkGmail } = await import('./helpers/gmail.js');
    const acctA = await linkGmail({ userId: userA.id, workspaceId: wsA, email: 'h@gmail.com' });
    await linkGmail({ userId: userA.id, workspaceId: wsA2, email: 'h@gmail.com' });
    await prisma.workspace.update({ where: { id: wsA }, data: { dailySendCap: 2 } });
    await prisma.workspace.update({ where: { id: wsA2 }, data: { dailySendCap: 2 } });
    const listA2 = await prisma.contactList.create({ data: { workspaceId: wsA2, name: 'Clients' } });
    const tplA2 = await prisma.template.create({ data: { workspaceId: wsA2, name: 'Client', body: 'Hi' } });
    const mk = async (workspaceId, listId, prefix, n) => {
      const ids = [];
      for (let i = 0; i < n; i += 1) ids.push((await prisma.recipient.create({ data: { workspaceId, listId, email: `${prefix}${i}@x.dev`, name: 'P' } })).id);
      return ids;
    };
    const fbIds = await mk(wsA, listA.id, 'fb', 2);
    const fvIds = await mk(wsA2, listA2.id, 'fv', 2);
    const fb = await cs.createCampaign({ workspaceId: wsA, name: 'FB send', subject: 'S', templateId: templateA.id, scheduledAt: new Date(), recipientIds: fbIds, listId: listA.id, createdById: userA.id });
    const fv = await cs.createCampaign({ workspaceId: wsA2, name: 'Fiverr send', subject: 'S', templateId: tplA2.id, scheduledAt: new Date(), recipientIds: fvIds, listId: listA2.id, createdById: userA.id });
    await prisma.campaignStep.updateMany({ where: { campaignId: { in: [fb.id, fv.id] } }, data: { status: 'sending' } });
    // Mixing is refused at the database level too: a FinanceBridge contact cannot be put on a Fiverr campaign.
    await assert.rejects(() => cs.createCampaign({ workspaceId: wsA2, name: 'Mix', subject: 'S', templateId: tplA2.id, scheduledAt: new Date(), recipientIds: [fbIds[0]], createdById: userA.id }));

    // B has no Gmail, so nobody can send B's campaigns, and A's Gmail is never borrowed.
    assert.equal(await scheduler.resolveSenderUser(null, wsB), null);
    assert.equal((await scheduler.resolveSenderUser(userA.id, wsA2)).id, acctA.id);
    assert.equal((await scheduler.resolveSenderUser(userA.id, wsA2)).userId, userA.id);

    // Kill switch in FinanceBridge does not stop Fiverr, and the other way round.
    await scheduler.setGlobalPause(wsA, true, 'test');
    const sends = [];
    const send = async (args) => {
      sends.push(args);
      return { messageId: `m${sends.length}`, threadId: `t${sends.length}` };
    };
    const hooks = { recordSend: cs.recordSend, recordBounce: cs.recordBounce, maybeCompleteCampaign: cs.maybeCompleteCampaign };
    const fresh = async () => {
      await prisma.gmailAccount.update({ where: { id: acctA.id }, data: { nextSendAt: null } });
      return prisma.gmailAccount.findUnique({ where: { id: acctA.id } });
    };
    let r = await scheduler.sendOneForSender(await fresh(), null, { send, hooks });
    assert.equal(r.sent, true);
    assert.equal(r.campaignId, fv.id, 'paused FinanceBridge is skipped, Fiverr still sends');
    assert.equal(sends[0].workspaceId, wsA2);
    await scheduler.setGlobalPause(wsA, false);

    // Daily cap of 2 per Gmail account across both workspaces: 1 Fiverr + 1 FB, then stop.
    r = await scheduler.sendOneForSender(await fresh(), null, { send, hooks });
    assert.equal(r.sent, true);
    r = await scheduler.sendOneForSender(await fresh(), null, { send, hooks });
    assert.equal(r.sent, false);
    assert.equal(r.reason, 'daily_cap', 'the cap counts sends from every workspace on this Gmail');
    assert.equal(sends.length, 2);
    for (const s of sends) {
      const person = await prisma.recipient.findUnique({ where: { id: s.recipientId } });
      const campaign = await prisma.campaign.findUnique({ where: { id: s.campaignId } });
      assert.equal(person.workspaceId, campaign.workspaceId, 'never sends a contact from another workspace');
    }

    // Sending status only lists this workspace's queue.
    const statusB = (await api(b, 'GET', '/sending/status')).json;
    assert.deepEqual(statusB.senders, [], 'B sees no Gmail accounts from other workspaces');

    // 9. A bounce seen in A's Gmail only marks contacts in workspaces A sends for.
    const sharedB = await prisma.recipient.findUnique({ where: { id: personB.id } });
    await prisma.recipient.update({ where: { id: sharedB.id }, data: { status: 'active' } });
    const stepA = await prisma.campaignStep.findFirst({ where: { campaign: { workspaceId: wsA } } });
    await prisma.campaignRecipient.create({
      data: { campaignId: stepA.campaignId, stepId: stepA.id, recipientId: personA.id, status: 'sent', sentAt: new Date(), senderId: userA.id, senderAccountId: acctA.id },
    });
    await cs.applyBounceNotices([{ email: 'shared@client.dev', reason: 'No such user' }], acctA);
    assert.equal((await prisma.recipient.findUnique({ where: { id: personA.id } })).status, 'bounced');
    assert.equal((await prisma.recipient.findUnique({ where: { id: personB.id } })).status, 'active', 'B is untouched');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await prisma.$disconnect();
  }
});
