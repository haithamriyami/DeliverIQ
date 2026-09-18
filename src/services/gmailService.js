import crypto from 'crypto';
import { google } from 'googleapis';
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../middleware/errorHandler.js';

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
];

function encKey() {
  return crypto.createHash('sha256').update(env.sessionSecret).digest();
}

function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', encKey(), iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${enc.toString('hex')}`;
}

function decrypt(payload) {
  const [ivHex, dataHex] = String(payload || '').split(':');
  if (!ivHex || !dataHex) {
    throw new Error('Invalid stored Gmail token');
  }
  const decipher = crypto.createDecipheriv('aes-256-cbc', encKey(), Buffer.from(ivHex, 'hex'));
  const dec = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
  return dec.toString('utf8');
}

export function googleConfigured() {
  return Boolean(env.google.clientId && env.google.clientSecret);
}

export function createOAuthClient() {
  return new google.auth.OAuth2(
    env.google.clientId,
    env.google.clientSecret,
    env.google.redirectUri
  );
}

export function gmailAuthUrl(state) {
  if (!googleConfigured()) {
    throw new HttpError(400, 'Google OAuth is not configured yet');
  }
  const client = createOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: GMAIL_SCOPES,
    state,
  });
}

export async function connectGmail({ workspaceId, code }) {
  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new HttpError(
      400,
      'Google did not return a refresh token. Remove DeliverIQ from your Google account access and connect again.'
    );
  }

  client.setCredentials(tokens);
  const oauth2 = google.oauth2({ version: 'v2', auth: client });
  const { data } = await oauth2.userinfo.get();

  return prisma.workspace.update({
    where: { id: workspaceId },
    data: {
      gmailEmail: data.email,
      gmailRefreshToken: encrypt(tokens.refresh_token),
      gmailConnectedAt: new Date(),
    },
  });
}

export async function disconnectGmail(workspaceId) {
  return prisma.workspace.update({
    where: { id: workspaceId },
    data: {
      gmailEmail: null,
      gmailRefreshToken: null,
      gmailConnectedAt: null,
    },
  });
}

export async function gmailStatus(workspaceId) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { gmailEmail: true, gmailConnectedAt: true },
  });

  return {
    configured: googleConfigured(),
    connected: Boolean(workspace?.gmailEmail),
    email: workspace?.gmailEmail || null,
    connectedAt: workspace?.gmailConnectedAt || null,
    redirectUri: env.google.redirectUri,
    origin: env.appUrl,
    localRedirectUri: 'http://127.0.0.1:3000/auth/google/callback',
  };
}

export async function getWorkspaceSender(workspaceId) {
  const workspace = workspaceId
    ? await prisma.workspace.findUnique({ where: { id: workspaceId } })
    : await prisma.workspace.findFirst({
        where: { gmailRefreshToken: { not: null } },
      });

  if (!workspace?.gmailRefreshToken) {
    return null;
  }

  return {
    email: workspace.gmailEmail,
    refreshToken: decrypt(workspace.gmailRefreshToken),
  };
}

export async function sendViaGmail({
  to,
  fromName,
  subject,
  html,
  unsubscribeUrl,
}) {
  const sender = await getWorkspaceSender();
  if (!sender) {
    return null;
  }

  const client = createOAuthClient();
  client.setCredentials({ refresh_token: sender.refreshToken });

  const gmail = google.gmail({ version: 'v1', auth: client });
  const from = fromName ? `${fromName} <${sender.email}>` : sender.email;
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`;
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
  ];
  if (unsubscribeUrl) {
    headers.push(`List-Unsubscribe: <${unsubscribeUrl}>`);
  }

  const raw = Buffer.from(`${headers.join('\r\n')}\r\n\r\n${html}`)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const response = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw },
  });

  return {
    dryRun: false,
    provider: 'gmail',
    messageId: response.data.id,
    from: sender.email,
  };
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const FAILED_HEADER_RE =
  /(?:final-recipient|original-recipient|x-failed-recipients|failed[- ]recipients?)\s*[:=]\s*(?:rfc822;?\s*)?([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi;
const BOUNCE_QUERY = [
  'newer_than:30d',
  '(',
  'from:mailer-daemon OR from:mailer-daemon@googlemail.com OR from:postmaster',
  'OR subject:"Delivery Status Notification"',
  'OR subject:Undeliverable OR subject:"Mail Delivery Subsystem"',
  'OR subject:"returned to sender" OR subject:"Delivery incomplete"',
  'OR subject:"Message not delivered" OR subject:"Address not found"',
  'OR subject:"Delivery Status Notification (Failure)"',
  'OR subject:"Delivery Status Notification (Delay)"',
  'OR subject:"Mail Delivery Failed" OR subject:"failure notice"',
  'OR "temporary problem delivering" OR "will try for"',
  'OR "couldn\'t be delivered" OR "could not be delivered"',
  'OR "wasn\'t delivered" OR "was not delivered"',
  'OR "delivery has failed" OR "permanently rejected"',
  ')',
].join(' ');

function decodeGmailData(data) {
  if (!data) return '';
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function collectGmailText(payload, chunks = []) {
  if (!payload) return chunks;
  if (payload.body?.data) {
    chunks.push(decodeGmailData(payload.body.data));
  }
  for (const part of payload.parts || []) {
    collectGmailText(part, chunks);
  }
  return chunks;
}

function emailsInText(text) {
  return [...new Set(String(text || '').toLowerCase().match(EMAIL_RE) || [])];
}

function failedEmailsFromText(text) {
  const found = new Set();
  const raw = String(text || '');
  for (const match of raw.matchAll(FAILED_HEADER_RE)) {
    if (match[1]) found.add(match[1].toLowerCase());
  }
  return [...found];
}

function bounceReasonFromText(text, subject = '') {
  const blob = `${subject}\n${text}`.toLowerCase();
  if (/address not found|user unknown|does not exist|no such user|mailbox unavailable|550|551|553/.test(blob)) {
    return 'Gmail: address not found / mailbox unavailable.';
  }
  if (/temporary problem|will try for|delivery incomplete|delay|try again later|421|450|451|452/.test(blob)) {
    return 'Gmail: delivery delayed or temporarily failed.';
  }
  if (/spam|blocked|rejected|policy|554/.test(blob)) {
    return 'Gmail: message rejected by the receiving server.';
  }
  if (/message not delivered|could not be delivered|wasn't delivered|delivery has failed|permanently rejected/.test(blob)) {
    return 'Gmail: message was not delivered.';
  }
  return 'Gmail reported this address as undeliverable or delayed.';
}

function isNoiseEmail(email, senderEmail) {
  if (!email) return true;
  if (email === senderEmail) return true;
  if (email.endsWith('.google.com') || email.endsWith('googlemail.com')) return true;
  if (email.startsWith('mailer-daemon@') || email.startsWith('postmaster@')) return true;
  return false;
}

async function listBounceMessageIds(gmail) {
  const ids = [];
  let pageToken;
  do {
    const list = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 100,
      q: BOUNCE_QUERY,
      pageToken,
    });
    for (const item of list.data.messages || []) {
      ids.push(item.id);
    }
    pageToken = list.data.nextPageToken || undefined;
  } while (pageToken && ids.length < 100);
  return ids.slice(0, 100);
}

export async function listGmailBounceAddresses() {
  const sender = await getWorkspaceSender();
  if (!sender) {
    throw new HttpError(400, 'Connect Gmail in Settings first.');
  }

  const client = createOAuthClient();
  client.setCredentials({ refresh_token: sender.refreshToken });
  const gmail = google.gmail({ version: 'v1', auth: client });
  const senderEmail = String(sender.email || '').toLowerCase();

  let messageIds;
  try {
    messageIds = await listBounceMessageIds(gmail);
  } catch (err) {
    const message = err.message || '';
    if (message.includes('insufficient') || message.includes('Insufficient') || err.code === 403 || err.response?.status === 403) {
      throw new HttpError(403, 'Reconnect Gmail in Settings so DeliverIQ can read bounce emails.');
    }
    throw err;
  }

  const byEmail = new Map();
  for (const id of messageIds) {
    const message = await gmail.users.messages.get({
      userId: 'me',
      id,
      format: 'full',
    });
    const headers = message.data.payload?.headers || [];
    const subject = headers.find((h) => h.name?.toLowerCase() === 'subject')?.value || '';
    const headerText = headers.map((h) => `${h.name}: ${h.value}`).join('\n');
    const bodyText = collectGmailText(message.data.payload).join('\n');
    const snippet = message.data.snippet || '';
    const fullText = `${headerText}\n${bodyText}\n${snippet}`;
    const reason = bounceReasonFromText(fullText, subject);

    let found = failedEmailsFromText(fullText);
    if (found.length === 0) {
      found = emailsInText(fullText);
    }

    for (const email of found) {
      if (isNoiseEmail(email, senderEmail)) continue;
      if (!byEmail.has(email)) {
        byEmail.set(email, reason);
      }
    }
  }

  return [...byEmail.entries()].map(([email, reason]) => ({ email, reason }));
}
