import { env } from '../config/env.js';
import { sgMail, sendgridEnabled } from '../config/sendgrid.js';
import { sendViaGmail } from './gmailService.js';
import { withEngagementTracking } from '../utils/tracking.js';

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
}) {
  const renderedSubject = interpolate(subject, { name, email: to });
  const renderedHtml = withEngagementTracking(
    withUnsubscribeFooter(
      interpolate(html, { name, email: to, unsubscribeUrl: unsubscribeUrl || '' }),
      unsubscribeUrl
    ),
    { campaignId, recipientId, stepId, unsubscribeUrl }
  );

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
