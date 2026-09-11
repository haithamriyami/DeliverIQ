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

export async function listGmailBounceAddresses() {
  const sender = await getWorkspaceSender();
  if (!sender) {
    throw new HttpError(400, 'Connect Gmail in Settings first.');
  }

  const client = createOAuthClient();
  client.setCredentials({ refresh_token: sender.refreshToken });
  const gmail = google.gmail({ version: 'v1', auth: client });
  const senderEmail = String(sender.email || '').toLowerCase();

  let list;
  try {
    list = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 50,
      q: [
        'newer_than:21d',
        '(from:mailer-daemon OR from:mailer-daemon@googlemail.com',
        'OR subject:"Delivery Status Notification"',
        'OR subject:Undeliverable OR subject:"Mail Delivery Subsystem"',
        'OR subject:"returned to sender"',
        'OR subject:"Delivery incomplete"',
        'OR "temporary problem delivering"',
        'OR "will try for")',
      ].join(' '),
    });
  } catch (err) {
    const message = err.message || '';
    if (message.includes('insufficient') || message.includes('Insufficient') || err.code === 403 || err.response?.status === 403) {
      throw new HttpError(403, 'Reconnect Gmail in Settings so DeliverIQ can read bounce emails.');
    }
    throw err;
  }

  const bounced = new Set();
  for (const item of list.data.messages || []) {
    const message = await gmail.users.messages.get({
      userId: 'me',
      id: item.id,
      format: 'full',
    });
    const headers = message.data.payload?.headers || [];
    const headerText = headers.map((h) => `${h.name}: ${h.value}`).join('\n');
    const bodyText = collectGmailText(message.data.payload).join('\n');
    const snippet = message.data.snippet || '';
    const found = emailsInText(`${headerText}\n${bodyText}\n${snippet}`).filter(
      (email) => email !== senderEmail && !email.endsWith('.google.com')
    );
    for (const email of found) {
      bounced.add(email);
    }
  }

  return [...bounced];
}
