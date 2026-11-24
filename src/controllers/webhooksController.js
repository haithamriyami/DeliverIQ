import crypto from 'crypto';
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { recordBounce } from '../services/campaignService.js';
import { checkCampaignBounceRate } from '../services/sendScheduler.js';
import { findSendGridAccount } from '../services/sendgridService.js';

export const SIGNATURE_HEADER = 'x-twilio-email-event-webhook-signature';
export const TIMESTAMP_HEADER = 'x-twilio-email-event-webhook-timestamp';
/** Reject signed events older than this, so a captured request cannot be replayed later. */
export const MAX_EVENT_AGE_SECONDS = 24 * 60 * 60;

function publicKeyPem(key) {
  const text = String(key || '').trim();
  if (text.includes('BEGIN PUBLIC KEY')) return text;
  const body = text.replace(/\s+/g, '').replace(/(.{64})/g, '$1\n').trim();
  return `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----\n`;
}

/**
 * SendGrid's Signed Event Webhook: an ECDSA (P-256, SHA-256) signature of timestamp + raw
 * body, checked with the verification key from SendGrid (SENDGRID_WEBHOOK_VERIFICATION_KEY).
 */
export function verifySendGridSignature({ rawBody, signature, timestamp, key = env.sendgrid.webhookVerificationKey, now = Date.now() }) {
  if (!key) return true;
  if (!rawBody || !signature || !timestamp) return false;
  const ts = Number(timestamp);
  if (Number.isFinite(ts) && Math.abs(now / 1000 - ts) > MAX_EVENT_AGE_SECONDS) return false;
  try {
    const verifier = crypto.createVerify('sha256');
    verifier.update(String(timestamp));
    verifier.update(rawBody);
    verifier.end();
    return verifier.verify(publicKeyPem(key), String(signature), 'base64');
  } catch {
    return false;
  }
}

function eventName(event) {
  return String(event?.event ?? '').toLowerCase();
}

function arg(event, name) {
  const value = event?.[name] ?? event?.custom_args?.[name] ?? event?.unique_args?.[name];
  return value == null || value === '' ? null : String(value);
}

/** SendGrid's sg_message_id is the x-message-id of the send plus a suffix. */
function sameMessage(recordedId, sgMessageId) {
  if (!recordedId || !sgMessageId) return false;
  return String(sgMessageId) === recordedId || String(sgMessageId).startsWith(`${recordedId}.`);
}

/**
 * The send an event is about: the campaign_recipients row for the step and contact in
 * custom_args, and only when SendGrid sent it. Without a verification key the event must
 * also carry the SendGrid message id of that send, so a made up request cannot mark
 * contacts bounced.
 */
async function resolveSend(event, { sendgridAccountId, signed }) {
  const stepId = arg(event, 'stepId');
  const recipientId = arg(event, 'recipientId');
  const campaignId = arg(event, 'campaignId');
  if (!recipientId || !campaignId || !sendgridAccountId) return null;
  const row = stepId
    ? await prisma.campaignRecipient.findUnique({ where: { stepId_recipientId: { stepId, recipientId } } })
    : await prisma.campaignRecipient.findFirst({
        where: { campaignId, recipientId, senderAccountId: sendgridAccountId },
        orderBy: { sentAt: 'desc' },
      });
  if (!row || row.campaignId !== campaignId || row.senderAccountId !== sendgridAccountId) return null;
  if (!signed && !sameMessage(row.messageId, event.sg_message_id)) return null;
  const recipient = await prisma.recipient.findUnique({ where: { id: recipientId } });
  if (!recipient) return null;
  if (event.email && String(event.email).toLowerCase() !== recipient.email.toLowerCase()) return null;
  return { row, recipient };
}

function bounceReason(event) {
  const detail = String(event.reason || event.response || event.status || '').replace(/\s+/g, ' ').trim();
  const kind = eventName(event) === 'dropped' ? 'SendGrid dropped this email' : 'SendGrid: address bounced';
  return `${kind}${detail ? `: ${detail}` : '.'}`.slice(0, 500);
}

/** Dropped because of an earlier unsubscribe or spam report: an opt out, not a bounce. */
function droppedAsOptOut(event) {
  return /unsubscribed|spam report/i.test(String(event.reason || ''));
}

/**
 * What each SendGrid event does. Bounces and unsubscribes are applied the same way as the
 * ones found in Gmail: the contact is marked bounced or unsubscribed (so no follow up goes
 * to them), the send row is marked bounced for the campaign counts, and the campaign pauses
 * itself when its bounce rate goes over the limit.
 * - bounce (type bounce), dropped: bounced.
 * - bounce with type "blocked": the receiving server refused it for now. Noted on the
 *   contact, not counted as a bounce (like a Gmail delay).
 * - spamreport, unsubscribe, group_unsubscribe, dropped for an unsubscribed address:
 *   unsubscribed and do not contact.
 * Opens and clicks are tracked by DeliverIQ itself, so SendGrid's are ignored.
 */
async function applyEvent(event, ctx, touched) {
  const name = eventName(event);
  const found = await resolveSend(event, ctx);
  if (!found) return { action: 'ignored' };
  const { row, recipient } = found;

  if (name === 'bounce' && String(event.type || '').toLowerCase() === 'blocked') {
    await prisma.recipient.update({ where: { id: recipient.id }, data: { lastError: bounceReason(event) } });
    return { action: 'noted' };
  }

  if ((name === 'bounce' || name === 'dropped') && !(name === 'dropped' && droppedAsOptOut(event))) {
    await recordBounce({ campaignId: row.campaignId, recipientId: recipient.id, stepId: row.stepId, error: bounceReason(event) });
    touched.add(row.campaignId);
    return { action: 'bounced' };
  }

  if (name === 'spamreport' || name === 'unsubscribe' || name === 'group_unsubscribe' || name === 'dropped') {
    await prisma.recipient.update({
      where: { id: recipient.id },
      data: { status: recipient.status === 'bounced' ? 'bounced' : 'unsubscribed', doNotContact: name === 'spamreport' ? true : recipient.doNotContact },
    });
    return { action: 'unsubscribed' };
  }

  return { action: 'ignored' };
}

export const handleSendGrid = asyncHandler(async (req, res) => {
  const key = env.sendgrid.webhookVerificationKey;
  const signed = Boolean(key);
  if (
    signed &&
    !verifySendGridSignature({
      rawBody: req.rawBody,
      signature: req.get(SIGNATURE_HEADER),
      timestamp: req.get(TIMESTAMP_HEADER),
      key,
    })
  ) {
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  const events = Array.isArray(req.body) ? req.body : [req.body];
  const sendgrid = await findSendGridAccount();
  const ctx = { sendgridAccountId: sendgrid?.id || null, signed };
  const touched = new Set();
  const counts = { bounced: 0, unsubscribed: 0, noted: 0, ignored: 0 };

  for (const event of events) {
    try {
      const { action } = await applyEvent(event, ctx, touched);
      counts[action] += 1;
    } catch (err) {
      console.error(`[sendgrid webhook] ${eventName(event)} failed: ${err.message}`);
      counts.ignored += 1;
    }
  }
  for (const campaignId of touched) {
    await checkCampaignBounceRate(campaignId).catch(() => {});
  }

  // Always 200 for a verified request so SendGrid does not keep retrying events we skip.
  res.json({ received: events.length, ...counts });
});
