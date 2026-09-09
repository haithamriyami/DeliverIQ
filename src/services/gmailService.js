import crypto from 'crypto';
import { google } from 'googleapis';
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../middleware/errorHandler.js';

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
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
