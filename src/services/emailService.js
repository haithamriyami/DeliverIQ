import { env } from '../config/env.js';
import { sgMail, sendgridEnabled } from '../config/sendgrid.js';
import { sendViaGmail } from './gmailService.js';
import { withEngagementTracking } from '../utils/tracking.js';
import { prisma } from '../lib/prisma.js';

export function interpolate(template, vars) {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    return vars[key] != null ? String(vars[key]) : '';
  });
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
 * Placeholder-aware SendGrid send.
 * When SENDGRID_DRY_RUN=true or the API key is a placeholder,
 * logs the payload instead of calling the network.
 */
export async function sendCampaignEmail({
  to,
  name,
  subject,
  html,
  campaignId,
  recipientId,
  stepId,
  unsubscribeUrl,
  userId,
}) {
  const renderedSubject = interpolate(subject, { name, email: to });
  const renderedHtml = withEngagementTracking(
    withUnsubscribeFooter(
      interpolate(html, { name, email: to, unsubscribeUrl: unsubscribeUrl || '' }),
      unsubscribeUrl
    ),
    { campaignId, recipientId, stepId, unsubscribeUrl }
  );

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
            select: { messageId: true, threadId: true },
          });
          
          if (prevSend?.messageId) {
            threadingInfo.inReplyTo = prevSend.messageId;
            threadingInfo.references = prevSend.messageId;
            threadingInfo.threadId = prevSend.threadId;
            break;
          }
        }
      }
    }
  }

  const message = {
    to,
    from: {
      email: env.sendgrid.fromEmail,
      name: env.sendgrid.fromName,
    },
    subject: renderedSubject,
    html: renderedHtml,
    customArgs: {
      campaignId,
      recipientId,
    },
    trackingSettings: {
      clickTracking: { enable: true },
      openTracking: { enable: true },
    },
  };

  if (unsubscribeUrl) {
    message.headers = {
      'List-Unsubscribe': `<${unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    };
  }

  const gmailResult = await sendViaGmail({
    to,
    fromName: env.sendgrid.fromName,
    subject: renderedSubject,
    html: renderedHtml,
    unsubscribeUrl,
    userId,
    ...threadingInfo,
  });
  if (gmailResult) {
    return gmailResult;
  }

  if (!sendgridEnabled) {
    throw new Error('Connect Gmail in Settings before sending. Nothing was delivered.');
  }

  const [response] = await sgMail.send(message);
  return {
    dryRun: false,
    messageId: response.headers['x-message-id'] ?? null,
    statusCode: response.statusCode,
  };
}

export function unsubscribeUrlFor(token) {
  return `${env.appUrl}/unsubscribe.html?token=${encodeURIComponent(token)}`;
}
