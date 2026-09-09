import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { applyEngagementEvent } from '../services/campaignService.js';
import { markRecipientInactive } from '../services/recipientService.js';

/**
 * Placeholder for SendGrid signed-event verification.
 * Wire ECDSA verification with SENDGRID_WEBHOOK_VERIFICATION_KEY in production.
 */
function verifySendGridSignature(_req) {
  if (!env.sendgrid.webhookVerificationKey) {
    return true;
  }

  // TODO: verify x-twilio-email-event-webhook-signature + timestamp
  return true;
}

function eventName(event) {
  return String(event.event ?? '').toLowerCase();
}

async function resolveRecipient(event) {
  if (event.recipientId) {
    return prisma.recipient.findUnique({ where: { id: event.recipientId } });
  }

  if (!event.email) {
    return null;
  }

  return prisma.recipient.findUnique({
    where: { email: String(event.email).toLowerCase() },
  });
}

export const handleSendGrid = asyncHandler(async (req, res) => {
  if (!verifySendGridSignature(req)) {
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  const events = Array.isArray(req.body) ? req.body : [req.body];
  const processed = [];

  for (const event of events) {
    const name = eventName(event);
    const recipient = await resolveRecipient(event);
    const campaignId = event.campaignId ?? event.campaign_id ?? null;
    const recipientId = recipient?.id ?? event.recipientId ?? null;

    if (name === 'bounce' || name === 'dropped' || name === 'spamreport') {
      if (recipient) {
        await markRecipientInactive(recipient.email, 'bounced');
      }
      await applyEngagementEvent({ campaignId, recipientId, event: 'bounce' });
      processed.push({ email: event.email, action: 'bounced' });
      continue;
    }

    if (name === 'unsubscribe' || name === 'group_unsubscribe') {
      if (recipient) {
        await markRecipientInactive(recipient.email, 'unsubscribed');
      }
      processed.push({ email: event.email, action: 'unsubscribed' });
      continue;
    }

    if (name === 'open' || name === 'click') {
      await applyEngagementEvent({
        campaignId,
        recipientId,
        event: name,
      });
      processed.push({ email: event.email, action: name });
    }
  }

  res.json({ received: events.length, processed });
});
