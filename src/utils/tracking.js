import crypto from 'crypto';
import { env } from '../config/env.js';

function signPayload(payload) {
  return crypto.createHmac('sha256', env.sessionSecret).update(payload).digest('base64url').slice(0, 16);
}

export function trackingToken(campaignId, recipientId) {
  const payload = Buffer.from(`${campaignId}:${recipientId}`, 'utf8').toString('base64url');
  return `${payload}~${signPayload(payload)}`;
}

export function parseTrackingToken(token) {
  const raw = String(token || '').replace(/\.gif$/i, '');
  if (!raw) {
    return null;
  }

  if (raw.includes('~')) {
    const [payload, sig] = raw.split('~');
    if (!payload || sig !== signPayload(payload)) {
      return null;
    }
    const [campaignId, recipientId] = Buffer.from(payload, 'base64url').toString('utf8').split(':');
    if (!campaignId || !recipientId) {
      return null;
    }
    return { campaignId, recipientId };
  }

  const parts = raw.split('.');
  if (parts.length < 3) {
    return null;
  }
  const sig = parts.pop();
  const recipientId = parts.pop();
  const campaignId = parts.join('.');
  const expected = crypto
    .createHmac('sha256', env.sessionSecret)
    .update(`${campaignId}.${recipientId}`)
    .digest('hex')
    .slice(0, 20);
  if (sig !== expected) {
    return null;
  }
  return { campaignId, recipientId };
}

export function isPrivateAppUrl(url = env.appUrl) {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local');
  } catch {
    return true;
  }
}

export function openPixelUrl(campaignId, recipientId) {
  return `${env.appUrl}/t/o/${trackingToken(campaignId, recipientId)}.gif`;
}

export function clickUrl(campaignId, recipientId, target) {
  return `${env.appUrl}/t/c/${trackingToken(campaignId, recipientId)}?u=${encodeURIComponent(target)}`;
}

export function withEngagementTracking(html, { campaignId, recipientId, unsubscribeUrl }) {
  if (!campaignId || !recipientId || recipientId === 'test') {
    return html;
  }

  const src = openPixelUrl(campaignId, recipientId);
  const pixel = `<img src="${src}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;overflow:hidden" />`;

  const tracked = html.replace(/href=["'](https?:\/\/[^"']+)["']/gi, (full, url) => {
    if (
      url.includes('/t/') ||
      url.includes('/unsubscribe') ||
      (unsubscribeUrl && url.startsWith(unsubscribeUrl.split('?')[0]))
    ) {
      return full;
    }
    return `href="${clickUrl(campaignId, recipientId, url)}"`;
  });

  if (tracked.includes('/t/o/')) {
    return tracked;
  }

  return `${pixel}${tracked}${pixel}`;
}
