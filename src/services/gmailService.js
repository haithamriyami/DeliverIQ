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

export async function connectGmail({ userId, code }) {
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

  return prisma.user.update({
    where: { id: userId },
    data: {
      gmailEmail: data.email,
      gmailRefreshToken: encrypt(tokens.refresh_token),
      gmailConnectedAt: new Date(),
    },
  });
}

export async function disconnectGmail(userId) {
  return prisma.user.update({
    where: { id: userId },
    data: {
      gmailEmail: null,
      gmailRefreshToken: null,
      gmailConnectedAt: null,
    },
  });
}

export async function gmailStatus(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { gmailEmail: true, gmailConnectedAt: true },
  });

  return {
    configured: googleConfigured(),
    connected: Boolean(user?.gmailEmail),
    email: user?.gmailEmail || null,
    connectedAt: user?.gmailConnectedAt || null,
    redirectUri: env.google.redirectUri,
    origin: env.appUrl,
    localRedirectUri: 'http://127.0.0.1:3000/auth/google/callback',
  };
}

export async function getUserSender(userId) {
  const user = userId
    ? await prisma.user.findUnique({ 
        where: { id: userId },
        include: { workspace: { select: { fromDisplayName: true, replyToEmail: true } } },
      })
    : await prisma.user.findFirst({
        where: { gmailRefreshToken: { not: null } },
        include: { workspace: { select: { fromDisplayName: true, replyToEmail: true } } },
      });

  if (!user?.gmailRefreshToken) {
    return null;
  }

  return {
    userId: user.id,
    email: user.gmailEmail,
    refreshToken: decrypt(user.gmailRefreshToken),
    fromDisplayName: user.workspace?.fromDisplayName,
    userName: user.name,
    replyToEmail: user.workspace?.replyToEmail,
  };
}

/**
 * The From display name. Order: explicit value for this send, the Settings value,
 * the connected user's name, then the mailbox name. Never the product name.
 */
export function resolveDisplayName({ fromName, fromDisplayName, userName, email } = {}) {
  const candidates = [fromName, fromDisplayName, userName];
  for (const value of candidates) {
    const clean = String(value || '').replace(/[\r\n<>"]/g, '').trim();
    if (clean && clean.toLowerCase() !== 'deliveriq') return clean;
  }
  return String(email || '').split('@')[0] || '';
}

function formatFrom(displayName, email) {
  if (!displayName) return email;
  // RFC 2047 encode non ASCII names, quote plain ones.
  if (/[^\x20-\x7e]/.test(displayName)) {
    return `=?UTF-8?B?${Buffer.from(displayName).toString('base64')}?= <${email}>`;
  }
  return `"${displayName.replace(/["\\]/g, '')}" <${email}>`;
}

export async function getWorkspaceSender(workspaceId) {
  return getUserSender(null);
}

function htmlToPlainText(html) {
  return html
    .replace(/<style[^>]*>.*?<\/style>/gis, '')
    .replace(/<script[^>]*>.*?<\/script>/gis, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<li>/gi, '- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<a[^>]*href=["']([^"']*)["'][^>]*>([^<]*)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    .trim();
}

export async function sendViaGmail({
  to,
  fromName,
  subject,
  html,
  unsubscribeUrl,
  replyTo,
  inReplyTo,
  references,
  threadId,
  userId,
}) {
  const sender = await getUserSender(userId);
  if (!sender) {
    return null;
  }

  const client = createOAuthClient();
  client.setCredentials({ refresh_token: sender.refreshToken });

  const gmail = google.gmail({ version: 'v1', auth: client });
  const displayName = resolveDisplayName({
    fromName,
    fromDisplayName: sender.fromDisplayName,
    userName: sender.userName,
    email: sender.email,
  });
  const from = formatFrom(displayName, sender.email);
  const plainText = htmlToPlainText(html);
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`;
  const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).substring(2)}`;
  
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  
  if (replyTo || sender.replyToEmail) {
    headers.push(`Reply-To: ${replyTo || sender.replyToEmail}`);
  }
  
  if (inReplyTo) {
    headers.push(`In-Reply-To: ${inReplyTo}`);
  }
  
  if (references) {
    headers.push(`References: ${references}`);
  }
  
  if (unsubscribeUrl) {
    headers.push(`List-Unsubscribe: <${unsubscribeUrl}>, <mailto:unsubscribe@deliveriq.local?subject=unsubscribe>`);
    headers.push('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
  }

  const body = [
    headers.join('\r\n'),
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    plainText,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    html,
    '',
    `--${boundary}--`,
  ].join('\r\n');

  const raw = Buffer.from(body)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const requestBody = { raw };
  if (threadId) {
    requestBody.threadId = threadId;
  }

  const response = await gmail.users.messages.send({
    userId: 'me',
    requestBody,
  });

  return {
    dryRun: false,
    provider: 'gmail',
    messageId: response.data.id,
    threadId: response.data.threadId,
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

function bounceTypeFromText(text, subject = '') {
  const blob = `${subject}\n${text}`.toLowerCase();
  
  if (/temporary problem|will try for|delivery incomplete|delay|try again later|still trying|421|450|451|452/.test(blob)) {
    return { type: 'delay', reason: 'Gmail: delivery delayed, will retry.' };
  }
  
  if (/address not found|user unknown|does not exist|no such user|mailbox unavailable|recipient address rejected|550|551|553/.test(blob)) {
    return { type: 'bounce', reason: 'Gmail: address not found or mailbox unavailable.' };
  }
  
  if (/spam|blocked|rejected|policy|prohibited|554/.test(blob)) {
    return { type: 'bounce', reason: 'Gmail: message rejected by the receiving server.' };
  }
  
  if (/message not delivered|could not be delivered|wasn't delivered|delivery has failed|permanently rejected|permanent error|permanent failure/.test(blob)) {
    return { type: 'bounce', reason: 'Gmail: message was not delivered (permanent failure).' };
  }
  
  return { type: 'bounce', reason: 'Gmail reported this address as undeliverable.' };
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
    const { type, reason } = bounceTypeFromText(fullText, subject);

    if (type === 'delay') {
      continue;
    }

    let found = failedEmailsFromText(fullText);
    if (found.length === 0) {
      found = emailsInText(fullText);
    }

    if (found.length === 0) {
      continue;
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

function headerOf(headers, name) {
  const lower = name.toLowerCase();
  return headers.find((h) => String(h.name || '').toLowerCase() === lower)?.value || '';
}

function plainTextOf(payload) {
  const plain = [];
  const html = [];
  (function walk(part) {
    if (!part) return;
    if (part.body?.data) {
      if (part.mimeType === 'text/plain') plain.push(decodeGmailData(part.body.data));
      else if (part.mimeType === 'text/html') html.push(decodeGmailData(part.body.data));
    }
    for (const child of part.parts || []) walk(child);
  })(payload);
  if (plain.length) return plain.join('\n');
  return htmlToPlainText(html.join('\n'));
}

/**
 * Recent inbound messages (not from us, not bounce notices) for one connected account.
 * Returns { id, threadId, fromEmail, subject, body, headers, snippet, receivedAt }.
 */
export async function listGmailInboundReplies(userId, { days = 14, max = 100 } = {}) {
  const sender = await getUserSender(userId);
  if (!sender) return [];

  const client = createOAuthClient();
  client.setCredentials({ refresh_token: sender.refreshToken });
  const gmail = google.gmail({ version: 'v1', auth: client });
  const senderEmail = String(sender.email || '').toLowerCase();

  const ids = [];
  let pageToken;
  do {
    const list = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 100,
      q: `newer_than:${days}d -from:me -from:mailer-daemon -from:postmaster -in:chats -in:sent`,
      pageToken,
    });
    for (const item of list.data.messages || []) ids.push(item);
    pageToken = list.data.nextPageToken || undefined;
  } while (pageToken && ids.length < max);

  const out = [];
  for (const item of ids.slice(0, max)) {
    const message = await gmail.users.messages.get({ userId: 'me', id: item.id, format: 'full' });
    const headers = message.data.payload?.headers || [];
    const fromRaw = headerOf(headers, 'From');
    const fromEmail = (String(fromRaw).toLowerCase().match(EMAIL_RE) || [])[0] || '';
    if (isNoiseEmail(fromEmail, senderEmail)) continue;
    out.push({
      id: message.data.id,
      threadId: message.data.threadId,
      fromEmail,
      subject: headerOf(headers, 'Subject'),
      body: plainTextOf(message.data.payload),
      headers,
      snippet: message.data.snippet || '',
      receivedAt: message.data.internalDate ? new Date(Number(message.data.internalDate)) : new Date(),
    });
  }
  return out;
}
