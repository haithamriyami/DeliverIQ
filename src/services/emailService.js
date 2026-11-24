import { env } from '../config/env.js';
import { sendViaGmail } from './gmailService.js';
import { sendViaSendGrid } from './sendgridService.js';
import { withEngagementTracking, looksLikeHtml, plainTextToHtml } from '../utils/tracking.js';
import { isThreadNotFoundError } from '../utils/sendErrors.js';
import { prisma } from '../lib/prisma.js';

export const NAME_FALLBACK = 'there';
export const ORGANIZATION_FALLBACK = 'your organization';

/**
 * Thread a follow up only when the earlier step was sent from the same Gmail account.
 * An unknown earlier sender is treated as different, so the follow up goes out as a
 * new email instead of asking Gmail for a thread this account may not have.
 */
export function shouldThreadFollowUp(previousSenderAccountId, currentAccountId) {
  return Boolean(
    previousSenderAccountId &&
      currentAccountId &&
      previousSenderAccountId === currentAccountId
  );
}

export function threadingForPreviousSend(prevSend, currentAccountId) {
  if (!prevSend?.messageId || !shouldThreadFollowUp(prevSend.senderAccountId, currentAccountId)) {
    return {};
  }
  return {
    inReplyTo: prevSend.messageId,
    references: prevSend.messageId,
    threadId: prevSend.threadId,
  };
}

/**
 * Send, and if a threaded attempt fails because Gmail cannot find the thread, retry
 * once immediately as a new email with the same subject and no thread headers.
 */
export async function sendWithThreadFallback(send, payload, threading = {}) {
  const threaded = Boolean(threading.threadId || threading.inReplyTo || threading.references);
  try {
    return await send({ ...payload, ...threading });
  } catch (err) {
    if (threaded && isThreadNotFoundError(err)) {
      console.warn(`[send] thread not found, retrying as a new email: ${err.message}`);
      return send(payload);
    }
    throw err;
  }
}

/** Values used to fill {{name}}, {{organization}} / {{company}}, {{email}} and {{unsubscribeUrl}}. */
export function mergeFieldValues({ name, email, organization, company, unsubscribeUrl } = {}) {
  const org = String(organization || company || '').trim() || ORGANIZATION_FALLBACK;
  const displayName = String(name || '').trim() || NAME_FALLBACK;
  return {
    name: displayName,
    first_name: displayName,
    email: email == null ? '' : String(email),
    organization: org,
    company: org,
    unsubscribeUrl: unsubscribeUrl || '',
  };
}

export function interpolate(template, vars = {}) {
  const filled = mergeFieldValues(vars);
  return String(template ?? '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    if (Object.prototype.hasOwnProperty.call(filled, key)) return filled[key];
    const raw = vars[key];
    return raw != null ? String(raw) : '';
  });
}

/** Subject and body with merge fields filled, for previews and tests. No tracking added. */
export function renderMergePreview({ body = '', subject = '', name, email, organization, company } = {}) {
  const vars = { name, email, organization, company };
  return {
    subject: interpolate(subject, vars),
    body: interpolate(body, vars),
    vars: mergeFieldValues(vars),
  };
}

function withUnsubscribeFooter(html, unsubscribeUrl) {
  if (!unsubscribeUrl) {
    return html;
  }

  if (html.includes(unsubscribeUrl)) {
    return html;
  }

  return `${html}
<p style="margin-top:32px;color:#64748b;font-size:12px;font-family:Inter,Arial,sans-serif">
  Don’t want these emails?
  <a href="${unsubscribeUrl}">Unsubscribe</a>
</p>`;
}

/**
 * Build the HTML that is actually sent: merge fields, plain text templates turned into
 * HTML, the unsubscribe footer, then tracked links (bare URLs included) and the open pixel.
 */
export function renderEmailHtml({ html, name, to, organization, company, campaignId, recipientId, stepId, unsubscribeUrl, campaignName }) {
  const merged = interpolate(html, { name, email: to, organization, company, unsubscribeUrl: unsubscribeUrl || '' });
  const asHtml = looksLikeHtml(merged) ? merged : plainTextToHtml(merged);
  return withEngagementTracking(withUnsubscribeFooter(asHtml, unsubscribeUrl), {
    campaignId,
    recipientId,
    stepId,
    unsubscribeUrl,
    campaignName,
  });
}

/**
 * Send one campaign email from the sender the scheduler picked.
 * provider "gmail" (default): the Gmail account accountId, threaded onto an earlier step
 * only when that step went out from the same Gmail account.
 * provider "sendgrid": through SendGrid with the workspace's SendGrid settings. A SendGrid
 * email is always a new email (never threaded): SendGrid's message id is not a Gmail thread,
 * and a follow up from a different sender than Email 1 goes out as a new email anyway.
 * There is no silent fallback from one provider to the other.
 */
export async function sendCampaignEmail({
  to,
  name,
  organization,
  company,
  subject,
  html,
  campaignId,
  recipientId,
  stepId,
  unsubscribeUrl,
  accountId,
  userId,
  campaignName,
  workspaceId,
  send,
  provider = 'gmail',
  sendgridSend,
}) {
  const renderedSubject = interpolate(subject, { name, email: to, organization, company });
  const renderedHtml = renderEmailHtml({
    html,
    name,
    to,
    organization,
    company,
    campaignId,
    recipientId,
    stepId,
    unsubscribeUrl,
    campaignName,
  });

  if (!workspaceId && campaignId) {
    const owner = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { workspaceId: true } });
    workspaceId = owner?.workspaceId;
  }

  if (provider === 'sendgrid') {
    return (sendgridSend || sendViaSendGrid)({
      workspaceId,
      to,
      subject: renderedSubject,
      html: renderedHtml,
      unsubscribeUrl,
      customArgs: { campaignId, recipientId, stepId, senderAccountId: accountId },
    });
  }

  let threadingInfo = {};
  if (stepId) {
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      include: { steps: { orderBy: { stepNumber: 'asc' } } },
    });
    
    if (campaign?.steps?.length > 1) {
      const currentStepIndex = campaign.steps.findIndex(s => s.id === stepId);
      if (currentStepIndex > 0) {
        const previousSteps = campaign.steps.slice(0, currentStepIndex);
        for (let i = previousSteps.length - 1; i >= 0; i--) {
          const prevStep = previousSteps[i];
          const prevSend = await prisma.campaignRecipient.findUnique({
            where: {
              stepId_recipientId: { stepId: prevStep.id, recipientId },
            },
            select: { messageId: true, threadId: true, senderAccountId: true },
          });

          if (prevSend?.messageId) {
            const nextThreading = threadingForPreviousSend(prevSend, accountId);
            if (nextThreading.inReplyTo || nextThreading.threadId) {
              threadingInfo = nextThreading;
              break;
            }
            // Different or unknown sender: keep looking for an earlier step from this account.
          }
        }
      }
    }
  }

  // Display name comes from Settings or the connected user's name (see resolveDisplayName).
  // The workspace being sent for decides the From name and reply to address.
  const gmailPayload = {
    workspaceId,
    to,
    subject: renderedSubject,
    html: renderedHtml,
    unsubscribeUrl,
    accountId,
    userId,
  };
  const gmailResult = await sendWithThreadFallback(send || sendViaGmail, gmailPayload, threadingInfo);
  if (gmailResult) {
    return gmailResult;
  }

  // The old code fell back to SendGrid here when no Gmail was connected. SendGrid is now its
  // own sender, switched on in Settings, so a missing Gmail never sends anything elsewhere.
  throw new Error('Connect Gmail in Settings before sending. Nothing was delivered.');
}

export function unsubscribeUrlFor(token) {
  return `${env.appUrl}/unsubscribe.html?token=${encodeURIComponent(token)}`;
}
