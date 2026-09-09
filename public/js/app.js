const pageMap = {
  dashboard: { top: 'dashboard', side: 'dashboard' },
  campaigns: { top: 'campaigns', side: 'campaigns' },
  templates: { top: 'templates', side: 'templates' },
  analytics: { top: 'analytics', side: 'analytics' },
  recipients: { top: 'campaigns', side: 'recipients' },
  reports: { top: 'analytics', side: 'reports' },
  settings: { top: 'dashboard', side: 'settings' },
  'new-campaign': { top: 'campaigns', side: 'campaigns' },
};

const charts = {};
let currentUser = null;
let inviteToken = null;

function showToast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2800);
}

function showAuthError(message) {
  const el = document.getElementById('auth-error');
  if (!el) {
    if (message) showToast(message);
    return;
  }
  if (!message) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = message;
  showToast(message);
}

function fmtDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function fmtNum(n) {
  return Number(n || 0).toLocaleString();
}

function pct(n) {
  return `${Math.round((Number(n) || 0) * 1000) / 10}%`;
}

function statusBadge(status) {
  const map = {
    completed: ['completed', 'Completed'],
    sending: ['sending', 'Sending...'],
    pending: ['scheduled', 'Scheduled'],
  };
  const [cls, label] = map[status] || ['pending', status];
  return `<span class="badge ${cls}">${label}</span>`;
}

async function api(path, options = {}) {
  const isForm = options.body instanceof FormData;
  const res = await fetch(path, {
    credentials: 'include',
    headers: isForm ? options.headers : { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || 'Request failed');
  }
  return data;
}

function setMenuOpen(open) {
  const app = document.getElementById('app');
  const btn = document.getElementById('menu-btn');
  app?.classList.toggle('menu-open', open);
  btn?.setAttribute('aria-expanded', open ? 'true' : 'false');
  btn?.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
}

function closeMenu() {
  setMenuOpen(false);
}

function toggleMenu() {
  const app = document.getElementById('app');
  setMenuOpen(!app?.classList.contains('menu-open'));
}

function showPage(name) {
  const page = pageMap[name] ? name : 'dashboard';
  document.querySelectorAll('.page').forEach((el) => {
    el.classList.toggle('active', el.id === `page-${page}`);
  });
  document.querySelectorAll('[data-top]').forEach((el) => {
    el.classList.toggle('active', el.dataset.top === pageMap[page].top);
  });
  document.querySelectorAll('[data-side]').forEach((el) => {
    el.classList.toggle('active', el.dataset.side === pageMap[page].side);
  });
  closeMenu();
  if (currentUser) {
    loadPageData(page);
  }
}

function currentPage() {
  const hash = (location.hash || '#dashboard').slice(1);
  if (hash.startsWith('invite=')) {
    return 'dashboard';
  }
  return hash;
}

function setAuthMode(mode, { email = '', workspace = '' } = {}) {
  const form = document.getElementById('auth-form');
  form.mode.value = mode;
  document.getElementById('auth-name-field').hidden = mode === 'login';
  document.getElementById('auth-workspace-field').hidden = mode !== 'register';
  document.getElementById('auth-name').required = mode !== 'login';
  document.getElementById('auth-email').value = email;
  if (workspace) {
    document.getElementById('auth-workspace').value = workspace;
  }
  const titles = {
    login: ['Log in', 'Welcome back to DeliverIQ.', 'Log in'],
    register: ['Create workspace', 'You’re first — this account becomes the owner.', 'Create workspace'],
    invite: ['Join workspace', 'Create your password to join the team.', 'Join team'],
  };
  const [title, lede, submit] = titles[mode];
  document.getElementById('auth-title').textContent = title;
  document.getElementById('auth-lede').textContent = lede;
  document.getElementById('auth-submit').textContent = submit;
  const switchEl = document.getElementById('auth-switch');
  if (mode === 'login') {
    switchEl.innerHTML = '';
  } else if (mode === 'register') {
    switchEl.innerHTML = '';
  } else {
    switchEl.innerHTML = '';
  }
}

function unlockApp(user) {
  currentUser = user;
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('locked');
  document.getElementById('hello-name').textContent = `Hello, ${user.name}`;
  document.getElementById('invite-form').style.display = user.role === 'owner' ? '' : 'none';
  showPage(currentPage());
}

function lockApp() {
  currentUser = null;
  document.getElementById('auth-screen').classList.remove('hidden');
  document.getElementById('app').classList.add('locked');
}

function campaignRow(campaign, { actions = false } = {}) {
  const totals = campaign.totals || {};
  const empty = campaign.status === 'pending';
  const actionHtml = actions
    ? `<td class="row-actions">
        <button class="btn btn-primary btn-small" data-send="${campaign.id}">Send</button>
        <button class="btn btn-ghost btn-small" data-test="${campaign.id}">Test send</button>
        <button class="btn btn-danger btn-small" data-delete-campaign="${campaign.id}">Delete</button>
      </td>`
    : '';
  return `<tr>
    <td>${campaign.name}</td>
    <td>${statusBadge(campaign.status)}</td>
    <td>${empty ? '—' : fmtNum(totals.sent)}</td>
    <td>${empty ? '—' : fmtNum(totals.opened)}</td>
    <td>${empty ? '—' : fmtNum(totals.clicked)}</td>
    <td>${fmtDate(campaign.scheduledAt)}</td>
    ${actionHtml}
  </tr>`;
}

function upsertChart(id, config) {
  if (charts[id]) {
    charts[id].destroy();
  }
  const canvas = document.getElementById(id);
  if (!canvas || typeof Chart === 'undefined') return;
  charts[id] = new Chart(canvas, config);
}

function drawDashboardCharts(dashboard) {
  const labels = dashboard.chart.length ? dashboard.chart.map((c) => c.label) : ['No data'];
  const opens = dashboard.chart.length ? dashboard.chart.map((c) => c.opens) : [0];
  const clicks = dashboard.chart.length ? dashboard.chart.map((c) => c.clicks) : [0];

  upsertChart('performanceChart', {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          type: 'bar',
          label: 'Clicks',
          data: clicks,
          backgroundColor: '#9ec2ff',
          borderRadius: 4,
          order: 2,
        },
        {
          type: 'line',
          label: 'Opens',
          data: opens,
          borderColor: '#2f6fed',
          borderWidth: 3,
          tension: 0.35,
          pointRadius: 0,
          order: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { display: dashboard.chart.length > 0 }, border: { display: false } },
        y: { min: 0, grid: { color: '#edf1f7' }, border: { display: false } },
      },
    },
  });

  const bounces = dashboard.bounceUnsub.bounces;
  const unsubs = dashboard.bounceUnsub.unsubscribes;
  const donut = (data, color) => ({
    type: 'doughnut',
    data: { datasets: [{ data, backgroundColor: [color, '#f1f5f9'], borderWidth: 0 }] },
    options: { cutout: '72%', plugins: { legend: { display: false }, tooltip: { enabled: false } } },
  });
  upsertChart('bounceChart', donut([bounces, Math.max(1, unsubs || 1)], '#e74c3c'));
  upsertChart('unsubChart', donut([unsubs, Math.max(1, bounces || 1)], '#f5a623'));
  upsertChart('analyticsChart', {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { type: 'bar', data: clicks, backgroundColor: '#9ec2ff', borderRadius: 4 },
        { type: 'line', data: opens, borderColor: '#2f6fed', borderWidth: 3, tension: 0.35, pointRadius: 0 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, border: { display: false } },
        y: { min: 0, grid: { color: '#edf1f7' }, border: { display: false } },
      },
    },
  });
}

async function loadDashboard() {
  const data = await api('/dashboard');
  document.getElementById('kpi-campaigns').textContent = fmtNum(data.kpis.totalCampaigns);
  document.getElementById('kpi-sent').textContent = fmtNum(data.kpis.emailsSent);
  document.getElementById('kpi-open').textContent = pct(data.kpis.openRate);
  document.getElementById('kpi-bounce').textContent = pct(data.kpis.bounceRate);
  document.getElementById('kpi-open-note').textContent =
    data.kpis.openRate >= 0.4 ? '↗ Good Engagement' : 'Keep testing subjects';
  document.getElementById('kpi-bounce-note').className =
    data.kpis.bounceRate > 0.02 ? 'kpi-note bad' : 'kpi-note good';
  document.getElementById('kpi-bounce-note').textContent =
    data.kpis.bounceRate > 0.02 ? '↘ Needs Attention' : 'Healthy';

  document.getElementById('recent-campaigns-body').innerHTML = data.recent.length
    ? data.recent.slice(0, 5).map((c) => campaignRow(c)).join('')
    : '<tr><td colspan="6" class="empty">No campaigns yet</td></tr>';

  document.getElementById('upcoming-schedule').innerHTML = data.upcoming.length
    ? data.upcoming
        .map(
          (c) => `<div class="schedule-item">
            <div class="schedule-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg></div>
            <div><div class="schedule-title">${c.name}</div><div class="schedule-sub">${fmtDate(c.scheduledAt)}</div></div>
          </div>`
        )
        .join('')
    : '<div class="empty">Nothing scheduled</div>';

  document.getElementById('bounce-label').textContent = `${fmtNum(data.bounceUnsub.bounces)} Bounces`;
  document.getElementById('unsub-label').textContent = `${fmtNum(data.bounceUnsub.unsubscribes)} Unsubscribes`;
  document.getElementById('analytics-quality').textContent = pct(1 - data.kpis.bounceRate);
  document.getElementById('analytics-quality-note').textContent = `Bounce rate ${pct(data.kpis.bounceRate)}`;
  drawDashboardCharts(data);
}

async function loadCampaigns() {
  const campaigns = await api('/campaigns');
  document.getElementById('campaigns-body').innerHTML = campaigns.length
    ? campaigns.map((c) => campaignRow(c, { actions: true })).join('')
    : '<tr><td colspan="7" class="empty">No campaigns yet</td></tr>';
  document.getElementById('reports-grid').innerHTML = campaigns.length
    ? campaigns
        .map(
          (c) => `<article class="card kpi">
            <div class="kpi-label">${c.name}</div>
            <div class="kpi-value">${c.status === 'pending' ? '—' : pct(c.rates?.openRate)}</div>
            <div class="kpi-note">${statusBadge(c.status)} · ${fmtNum(c.totals?.clicked || 0)} clicks</div>
          </article>`
        )
        .join('')
    : '<p class="empty">No reports yet</p>';
}

async function loadRecipients() {
  const recipients = await api('/recipients');
  document.getElementById('recipients-body').innerHTML = recipients.length
    ? recipients
        .map(
          (r) => `<tr>
            <td>${r.name}</td>
            <td>${r.email}</td>
            <td>${r.timezone}</td>
            <td>${r.notes || '—'}</td>
            <td><span class="status-dot ${r.status}"></span>${r.status}</td>
            <td class="row-actions">
              <button class="btn btn-danger btn-small" data-delete-recipient="${r.id}">Delete</button>
            </td>
          </tr>`
        )
        .join('')
    : '<tr><td colspan="6" class="empty">No recipients yet</td></tr>';

  document.getElementById('c-recipients').innerHTML = recipients
    .filter((r) => r.status === 'active')
    .map(
      (r) => `<label><input type="checkbox" name="recipientIds" value="${r.id}" /> ${r.name} · ${r.email}</label>`
    )
    .join('') || '<p class="muted">Add recipients first</p>';
}

async function loadTemplates() {
  const templates = await api('/templates');
  document.getElementById('template-grid').innerHTML = templates.length
    ? templates
        .map(
          (t) => `<article class="card template-card">
            <h3>${t.name}</h3>
            <p>${t.body.replace(/<[^>]+>/g, ' ').slice(0, 140)}</p>
            <button class="btn btn-danger btn-small" data-delete-template="${t.id}">Delete</button>
          </article>`
        )
        .join('')
    : '<p class="empty">No templates yet</p>';
  const select = document.getElementById('c-template');
  select.innerHTML = templates.map((t) => `<option value="${t.id}">${t.name}</option>`).join('');
}

async function loadSettings() {
  const [me, team] = await Promise.all([api('/auth/me'), api('/auth/team')]);
  const sg = me.sendgrid;
  const google = me.google || {};
  document.getElementById('sendgrid-status').innerHTML = sg.enabled
    ? `<span class="sendgrid-pill live">SendGrid live · ${sg.fromEmail}</span>`
    : `<span class="sendgrid-pill dry">SendGrid dry run · ${sg.fromEmail}</span>`;

  const gmailEl = document.getElementById('gmail-status');
  const actions = document.getElementById('gmail-actions');
  if (google.connected) {
    gmailEl.innerHTML = `<span class="sendgrid-pill live">Gmail connected · ${google.email}</span>`;
    actions.innerHTML =
      me.user.role === 'owner'
        ? '<button class="btn btn-ghost" id="gmail-disconnect" type="button">Disconnect Gmail</button>'
        : '';
  } else if (google.configured) {
    gmailEl.innerHTML = '<span class="sendgrid-pill dry">Gmail ready — connect your Google account</span>';
    actions.innerHTML =
      me.user.role === 'owner'
        ? '<a class="btn btn-primary" href="/auth/google">Connect Gmail</a>'
        : '<p class="muted">Ask the owner to connect Gmail in Settings.</p>';
  } else {
    gmailEl.innerHTML = '<span class="sendgrid-pill dry">Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env</span>';
    actions.innerHTML = `<p class="muted">Redirect URI to paste in Google Cloud: <code>${google.redirectUri || ''}</code></p>`;
  }

  const tracking = me.tracking || {};
  let trackingNote = document.getElementById('tracking-note');
  if (!trackingNote) {
    trackingNote = document.createElement('p');
    trackingNote.id = 'tracking-note';
    trackingNote.className = 'muted';
    gmailEl.parentElement?.appendChild(trackingNote);
  }
  trackingNote.textContent = tracking.public
    ? `Open tracking is live at ${tracking.appUrl}`
    : 'Opens cannot be counted while the app is on localhost. Gmail loads images from Google’s servers, which cannot reach this PC. After we deploy to HTTPS, new emails will record opens.';

  document.getElementById('team-list').innerHTML = [
    ...team.users.map(
      (u) => `<div class="team-row"><span>${u.name} · ${u.email}</span><strong>${u.role}</strong></div>`
    ),
    ...team.invites.map(
      (i) => `<div class="team-row"><span>${i.email}</span><span class="muted">invite pending</span></div>`
    ),
  ].join('');
}

async function loadPageData(page) {
  try {
    if (page === 'dashboard' || page === 'analytics') await loadDashboard();
    if (page === 'campaigns' || page === 'reports') await loadCampaigns();
    if (page === 'recipients' || page === 'new-campaign') {
      await loadRecipients();
      await loadTemplates();
    }
    if (page === 'templates') await loadTemplates();
    if (page === 'settings') await loadSettings();
  } catch (err) {
    if (String(err.message).includes('log in')) {
      if (!currentUser) lockApp();
      else showAuthError(err.message);
      return;
    }
    showToast(err.message);
  }
}

document.addEventListener('click', (event) => {
  const jump = event.target.closest('[data-page]');
  if (jump) location.hash = jump.dataset.page;
});

document.addEventListener('click', async (event) => {
  const sendBtn = event.target.closest('[data-send]');
  const testBtn = event.target.closest('[data-test]');
  try {
    if (sendBtn) {
      if (!confirm('Send this campaign to all eligible recipients now?')) return;
      const result = await api(`/campaigns/${sendBtn.dataset.send}/send`, { method: 'POST' });
      if (result.enqueued) {
        showToast(`Sent ${result.enqueued} email${result.enqueued === 1 ? '' : 's'}`);
      } else {
        showToast('Nothing to send — already sent or recipients inactive');
      }
      if (result.failed) {
        showToast(`${result.failed} failed${result.errors?.[0]?.error ? `: ${result.errors[0].error}` : ''}`);
      }
      await loadCampaigns();
      await loadDashboard();
    }
    if (testBtn) {
      const email = prompt('Send a test to which email?', currentUser?.email || '');
      if (!email) return;
      await api(`/campaigns/${testBtn.dataset.test}/test`, {
        method: 'POST',
        body: JSON.stringify({ email }),
      });
      showToast('Test email sent');
    }
    const delCampaign = event.target.closest('[data-delete-campaign]');
    const delRecipient = event.target.closest('[data-delete-recipient]');
    const delTemplate = event.target.closest('[data-delete-template]');
    if (delCampaign) {
      if (!confirm('Delete this campaign? This cannot be undone.')) return;
      await api(`/campaigns/${delCampaign.dataset.deleteCampaign}`, { method: 'DELETE' });
      showToast('Campaign deleted');
      await loadCampaigns();
      await loadDashboard();
    }
    if (delRecipient) {
      if (!confirm('Delete this recipient? This cannot be undone.')) return;
      await api(`/recipients/${delRecipient.dataset.deleteRecipient}`, { method: 'DELETE' });
      showToast('Recipient deleted');
      await loadRecipients();
    }
    if (delTemplate) {
      if (!confirm('Delete this template? This cannot be undone.')) return;
      await api(`/templates/${delTemplate.dataset.deleteTemplate}`, { method: 'DELETE' });
      showToast('Template deleted');
      await loadTemplates();
    }
  } catch (err) {
    showToast(err.message);
  }
});

window.addEventListener('hashchange', () => showPage(currentPage()));

document.getElementById('auth-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  event.stopPropagation();
  const form = event.currentTarget;
  const submitBtn = document.getElementById('auth-submit');
  const mode = form.querySelector('[name="mode"]')?.value || 'login';
  const email = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  showAuthError('');

  if (!email || !password) {
    showAuthError('Enter your email and password.');
    return;
  }
  if (password.length < 8) {
    showAuthError('Password must be at least 8 characters.');
    return;
  }

  const previousLabel = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = mode === 'login' ? 'Signing in…' : 'Please wait…';

  try {
    if (mode === 'register') {
      const data = await api('/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          name: document.getElementById('auth-name').value.trim(),
          email,
          password,
          workspaceName: document.getElementById('auth-workspace').value.trim() || 'DeliverIQ',
        }),
      });
      unlockApp(data.user);
      showToast('Workspace created');
      return;
    }
    if (mode === 'invite') {
      const data = await api('/auth/accept-invite', {
        method: 'POST',
        body: JSON.stringify({
          token: inviteToken,
          name: document.getElementById('auth-name').value.trim(),
          password,
        }),
      });
      location.hash = 'dashboard';
      unlockApp(data.user);
      showToast('You joined the workspace');
      return;
    }
    const data = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    unlockApp(data.user);
  } catch (err) {
    showAuthError(err.message || 'Could not log in');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = previousLabel;
  }
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' });
  lockApp();
  setAuthMode('login');
});

document.getElementById('campaign-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const recipientIds = [...form.querySelectorAll('input[name="recipientIds"]:checked')].map((el) => el.value);
  if (!recipientIds.length) {
    showToast('Pick at least one recipient');
    return;
  }
  try {
    await api('/campaigns', {
      method: 'POST',
      body: JSON.stringify({
        name: form.name.value.trim(),
        subject: form.subject.value.trim(),
        templateId: form.templateId.value,
        scheduledAt: new Date(form.scheduledAt.value).toISOString(),
        recipientIds,
        notes: form.notes.value.trim(),
      }),
    });
    showToast('Campaign created');
    location.hash = 'campaigns';
    form.reset();
  } catch (err) {
    showToast(err.message);
  }
});

document.getElementById('template-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await api('/templates', {
      method: 'POST',
      body: JSON.stringify({ name: form.name.value.trim(), body: form.body.value }),
    });
    form.reset();
    showToast('Template saved');
    await loadTemplates();
  } catch (err) {
    showToast(err.message);
  }
});

document.getElementById('recipient-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await api('/recipients', {
      method: 'POST',
      body: JSON.stringify({
        name: form.name.value.trim(),
        email: form.email.value.trim(),
        timezone: form.timezone.value.trim() || 'UTC',
        notes: form.notes.value.trim(),
      }),
    });
    form.reset();
    showToast('Recipient added');
    await loadRecipients();
  } catch (err) {
    showToast(err.message);
  }
});

document.getElementById('csv-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = document.getElementById('csv-file').files[0];
  const pasted = document.getElementById('csv-text').value.trim();
  try {
    let summary;
    if (file) {
      const body = new FormData();
      body.append('file', file);
      summary = await api('/recipients/import', { method: 'POST', body });
    } else {
      summary = await api('/recipients/import', {
        method: 'POST',
        body: JSON.stringify({ csv: pasted }),
      });
    }
    showToast(`Imported ${summary.created} new, ${summary.updated} updated`);
    document.getElementById('csv-form').reset();
    await loadRecipients();
  } catch (err) {
    showToast(err.message);
  }
});

document.addEventListener('click', async (event) => {
  if (event.target.id !== 'gmail-disconnect') return;
  try {
    await api('/auth/google/disconnect', { method: 'POST' });
    showToast('Gmail disconnected');
    await loadSettings();
  } catch (err) {
    showToast(err.message);
  }
});

document.getElementById('invite-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const invite = await api('/auth/invites', {
      method: 'POST',
      body: JSON.stringify({ email: event.currentTarget.email.value.trim() }),
    });
    document.getElementById('invite-result').innerHTML = `<div class="invite-url">Invite link: ${invite.inviteUrl}</div>`;
    showToast('Invite created — send this link to your partner');
    event.currentTarget.reset();
    await loadSettings();
  } catch (err) {
    showToast(err.message);
  }
});

document.getElementById('password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await api('/auth/password', {
      method: 'POST',
      body: JSON.stringify({
        currentPassword: form.currentPassword.value,
        newPassword: form.newPassword.value,
      }),
    });
    form.reset();
    showToast('Password updated');
  } catch (err) {
    showToast(err.message);
  }
});

async function boot() {
  const hash = (location.hash || '').slice(1);
  if (hash.startsWith('invite=')) {
    inviteToken = hash.slice(7);
    try {
      const preview = await api(`/auth/invites/preview?token=${encodeURIComponent(inviteToken)}`);
      setAuthMode('invite', { email: preview.email, workspace: preview.workspaceName });
      document.getElementById('auth-email').readOnly = true;
      document.getElementById('auth-lede').textContent = `Join ${preview.workspaceName} as ${preview.email}`;
      lockApp();
      return;
    } catch (err) {
      showToast(err.message);
    }
  }

  try {
    const me = await api('/auth/me');
    unlockApp(me.user);
  } catch {
    const status = await api('/auth/status');
    setAuthMode(status.setupRequired ? 'register' : 'login');
    lockApp();
  }
}

boot();

document.getElementById('menu-btn')?.addEventListener('click', toggleMenu);
document.getElementById('sidebar-backdrop')?.addEventListener('click', closeMenu);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeMenu();
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  });
}
