/**
 * SendGrid as a second sender, next to Gmail.
 *
 * - Off by default. A workspace owner turns it on in Settings (sendgrid_senders.enabled).
 * - The API key only ever comes from the SENDGRID_API_KEY environment variable. It is never
 *   stored in the database, logged or sent to the browser.
 * - All workspaces share the one SendGrid account behind that key, so the throttle state
 *   (next send slot, rolling 24 hour count, holds and pauses) lives on one gmail_accounts
 *   row with email "sendgrid". Sends are recorded with sender_account_id = that row, which
 *   is how the daily cap is counted and how follow ups know which sender sent Email 1.
 * - SENDGRID_DRY_RUN is not used here. The Settings switch is the only thing that turns
 *   SendGrid sending on, so a send is never recorded as sent without really going out.
 */
import sgMail from '@sendgrid/mail';
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { htmlToPlainText, resolveDisplayName } from './gmailService.js';

export const SENDGRID_ACCOUNT_EMAIL = 'sendgrid';
export const DEFAULT_SENDGRID_DAILY_CAP = 100;
export const SENDGRID_CAP_LIMITS = Object.freeze({ min: 1, max: 2000 });
/** Start of the app's note for the SendGrid sender held by its account limit. */
export const SENDGRID_LIMIT_MARKER = 'SendGrid daily sending limit reached';

let clientOverride = null;
let configuredKey = null;

/** Tests inject a fake client here so nothing reaches SendGrid. */
export function setSendGridClient(client) {
  clientOverride = client;
}

export function sendGridKeyConfigured(key = env.sendgrid.apiKey) {
  return Boolean(key) && !String(key).startsWith('placeholder');
}

function client() {
  if (clientOverride) return clientOverride;
  if (!sendGridKeyConfigured()) {
    throw Object.assign(new Error('SENDGRID_API_KEY is not set, so SendGrid cannot send.'), { code: 401 });
  }
  if (configuredKey !== env.sendgrid.apiKey) {
    sgMail.setApiKey(env.sendgrid.apiKey);
    configuredKey = env.sendgrid.apiKey;
  }
  return sgMail;
}

export function isSendGridAccount(account) {
  return account?.email === SENDGRID_ACCOUNT_EMAIL;
}

function clampCap(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return DEFAULT_SENDGRID_DAILY_CAP;
  return Math.min(SENDGRID_CAP_LIMITS.max, Math.max(SENDGRID_CAP_LIMITS.min, n));
}

/**
 * The table is new. Preview deployments share the production database and never run
 * migrations, so until this is merged the table may be missing: treat that as "off".
 */
function missingTable(err) {
  return err?.code === 'P2021' || /sendgrid_senders/.test(String(err?.message || '')) && /does not exist/.test(String(err?.message || ''));
}

async function settingsRow(workspaceId) {
  if (!workspaceId) return null;
  try {
    return await prisma.sendgridSender.findUnique({ where: { workspaceId } });
  } catch (err) {
    if (missingTable(err)) return null;
    throw err;
  }
}

/** SendGrid settings for a workspace, with defaults filled in. Never includes the key. */
export async function sendGridSettings(workspaceId, { workspace } = {}) {
  const row = await settingsRow(workspaceId);
  const ws =
    workspace ||
    (workspaceId
      ? await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { fromDisplayName: true, replyToEmail: true } })
      : null);
  const fromEmail = String(row?.fromEmail || env.sendgrid.fromEmail || '').trim().toLowerCase();
  const fromName = resolveDisplayName({ fromName: row?.fromName, fromDisplayName: env.sendgrid.fromName || ws?.fromDisplayName, email: fromEmail });
  return {
    enabled: Boolean(row?.enabled),
    dailyCap: clampCap(row?.dailyCap ?? DEFAULT_SENDGRID_DAILY_CAP),
    fromEmail,
    fromName,
    replyToEmail: String(row?.replyToEmail || ws?.replyToEmail || '').trim(),
    keyConfigured: sendGridKeyConfigured(),
    saved: Boolean(row),
  };
}

/** Can SendGrid send for this workspace right now (switch on, key set, From address set)? */
export function sendGridReady(settings) {
  return Boolean(settings?.enabled && settings.keyConfigured && settings.fromEmail);
}

/** Workspaces with SendGrid switched on. Empty when the key is missing or the table is new. */
export async function sendGridWorkspaceIds() {
  if (!sendGridKeyConfigured()) return [];
  try {
    const rows = await prisma.sendgridSender.findMany({ where: { enabled: true, NOT: { fromEmail: '' } }, select: { workspaceId: true } });
    const ids = rows.map((row) => row.workspaceId);
    // A workspace with no From address of its own uses SENDGRID_FROM_EMAIL.
    if (env.sendgrid.fromEmail) {
      const blank = await prisma.sendgridSender.findMany({ where: { enabled: true, fromEmail: '' }, select: { workspaceId: true } });
      ids.push(...blank.map((row) => row.workspaceId));
    }
    return [...new Set(ids)];
  } catch (err) {
    if (missingTable(err)) return [];
    throw err;
  }
}

export async function isSendGridEnabledFor(workspaceId) {
  return sendGridReady(await sendGridSettings(workspaceId));
}

/** The shared throttle row for SendGrid (created on first save of the settings). */
export async function findSendGridAccount() {
  return prisma.gmailAccount.findUnique({ where: { email: SENDGRID_ACCOUNT_EMAIL } });
}

export async function ensureSendGridAccount() {
  return prisma.gmailAccount.upsert({
    where: { email: SENDGRID_ACCOUNT_EMAIL },
    create: { email: SENDGRID_ACCOUNT_EMAIL, refreshToken: null, connectedAt: new Date() },
    update: {},
  });
}

/** Save the workspace's SendGrid settings. Only the given fields change. */
export async function saveSendGridSettings(workspaceId, { enabled, dailyCap, fromEmail, fromName, replyToEmail } = {}) {
  const data = {};
  if (enabled != null) data.enabled = Boolean(enabled);
  if (dailyCap != null) data.dailyCap = clampCap(dailyCap);
  if (fromEmail != null) data.fromEmail = String(fromEmail).trim().toLowerCase();
  if (fromName != null) data.fromName = String(fromName).replace(/[\r\n<>"]/g, '').trim();
  if (replyToEmail != null) data.replyToEmail = String(replyToEmail).trim();
  try {
    await prisma.sendgridSender.upsert({ where: { workspaceId }, create: { workspaceId, ...data }, update: data });
  } catch (err) {
    if (missingTable(err)) {
      throw Object.assign(new Error('SendGrid settings are not available on this deployment yet.'), { status: 503 });
    }
    throw err;
  }
  await ensureSendGridAccount();
  return sendGridSettings(workspaceId);
}

/** SendGrid custom_args must be strings. */
function stringArgs(args = {}) {
  const out = {};
  for (const [key, value] of Object.entries(args)) {
    if (value != null && value !== '') out[key] = String(value);
  }
  return out;
}

/**
 * Send one email through SendGrid. DeliverIQ adds its own open and click tracking and its
 * own unsubscribe link, so SendGrid's are turned off (no double tracking, no second
 * unsubscribe footer). custom_args carry the ids the Event Webhook needs.
 */
export async function sendViaSendGrid({ workspaceId, to, subject, html, unsubscribeUrl, customArgs = {}, settings } = {}) {
  const config = settings || (await sendGridSettings(workspaceId));
  if (!config.fromEmail) {
    throw Object.assign(new Error('Set the SendGrid From address in Settings before sending.'), { code: 400, sendgridConfig: true });
  }
  const message = {
    to,
    from: config.fromName ? { email: config.fromEmail, name: config.fromName } : config.fromEmail,
    subject,
    html,
    text: htmlToPlainText(html),
    customArgs: stringArgs(customArgs),
    trackingSettings: {
      clickTracking: { enable: false, enableText: false },
      openTracking: { enable: false },
      subscriptionTracking: { enable: false },
    },
  };
  if (config.replyToEmail) message.replyTo = config.replyToEmail;
  if (unsubscribeUrl) {
    message.headers = {
      'List-Unsubscribe': `<${unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    };
  }
  const [response] = await client().send(message);
  const headers = response?.headers || {};
  return {
    dryRun: false,
    provider: 'sendgrid',
    messageId: headers['x-message-id'] || headers['X-Message-Id'] || null,
    threadId: null,
    from: config.fromEmail,
    statusCode: response?.statusCode,
  };
}

function sendGridErrorText(err) {
  const errors = err?.response?.body?.errors || [];
  return `${err?.message || ''} ${errors.map((e) => `${e?.field || ''} ${e?.message || ''}`).join(' ')}`.toLowerCase();
}

/**
 * Same kinds as classifySendError for Gmail, from SendGrid's HTTP errors:
 * - daily_limit: the account's sending credits are used up ("Maximum credits exceeded").
 * - transient: 429 or 5xx, try again a little later.
 * - auth: key missing, revoked or without Mail Send, or the From address is not allowed.
 * - recipient: SendGrid says this one address is invalid (treated as a bounce).
 * - send_error: anything else. Not a bounce, the contact stays queued.
 */
export function classifySendGridError(err) {
  const status = Number(err?.code || err?.response?.statusCode || err?.status || 0);
  const text = sendGridErrorText(err);
  if (/maximum credits exceeded|credits? (exceeded|limit)|daily (sending )?limit/.test(text)) return 'daily_limit';
  if (status === 429 || status >= 500 || /too many requests|rate limit/.test(text)) return 'transient';
  if (err?.sendgridConfig) return 'auth';
  if (status === 401 || status === 403 || /unauthori[sz]ed|forbidden|permission|api key|sender identity|from address does not match/.test(text)) return 'auth';
  if (status === 400 && /(to|personalizations).*email|does not contain a valid address|invalid email/.test(text)) return 'recipient';
  return 'send_error';
}

export function sendGridPauseMessage(err) {
  const detail = String(err?.message || '').slice(0, 300);
  return `SendGrid refused the send. Check that SENDGRID_API_KEY is set with Mail Send access and that the From address is on a domain verified in SendGrid, then press Resume. SendGrid said: ${detail}`;
}
