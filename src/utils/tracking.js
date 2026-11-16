import crypto from 'crypto';
import { env } from '../config/env.js';

function signPayload(payload) {
  return crypto.createHmac('sha256', env.sessionSecret).update(payload).digest('base64url').slice(0, 16);
}

export function trackingToken(campaignId, recipientId, stepId) {
  const payload = Buffer.from(
    stepId ? `${campaignId}:${recipientId}:${stepId}` : `${campaignId}:${recipientId}`,
    'utf8'
  ).toString('base64url');
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
    const [campaignId, recipientId, stepId] = Buffer.from(payload, 'base64url').toString('utf8').split(':');
    if (!campaignId || !recipientId) {
      return null;
    }
    return { campaignId, recipientId, stepId: stepId || undefined };
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

export function openPixelUrl(campaignId, recipientId, stepId) {
  return `${env.appUrl}/t/o/${trackingToken(campaignId, recipientId, stepId)}.gif`;
}

export function clickUrl(campaignId, recipientId, target, stepId) {
  return `${env.appUrl}/t/c/${trackingToken(campaignId, recipientId, stepId)}?u=${encodeURIComponent(target)}`;
}

/** "Accountants - United Kingdom" becomes "accountants-united-kingdom". */
export function campaignSlug(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * Add utm_source, utm_medium and utm_campaign when they are missing.
 * Any utm value already in the link is kept exactly as written.
 */
export function withUtm(url, campaignName) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    return url;
  }
  const slug = campaignSlug(campaignName);
  const wanted = [
    ['utm_source', 'email'],
    ['utm_medium', 'email'],
    ['utm_campaign', slug],
  ].filter(([key, value]) => value && !parsed.searchParams.has(key));
  if (!wanted.length) {
    return url;
  }
  const extra = wanted.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  const hashAt = url.indexOf('#');
  const base = hashAt === -1 ? url : url.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : url.slice(hashAt);
  const joiner = base.includes('?') ? (/[?&]$/.test(base) ? '' : '&') : '?';
  return `${base}${joiner}${extra}${hash}`;
}

function decodeEntities(text) {
  return String(text)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** True when the body already uses HTML tags; otherwise it is a plain text template. */
export function looksLikeHtml(body) {
  return /<\/?(p|br|div|a|span|table|img|strong|em|b|i|ul|ol|li|h[1-6]|html|body)\b[^>]*>/i.test(String(body || ''));
}

/**
 * Templates are written as plain text. Sent as HTML, their line breaks collapse and
 * links are not real links, so turn line breaks into <br> and escape the text.
 */
export function plainTextToHtml(text) {
  return escapeHtml(String(text || '').replace(/\r\n?/g, '\n')).replace(/\n/g, '<br>\n');
}

const BARE_URL = /https?:\/\/[^\s<>"']+/gi;

function splitTrailing(url) {
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1];
    if ('.,;:!?'.includes(ch)) {
      end -= 1;
      continue;
    }
    if (ch === ')') {
      const body = url.slice(0, end);
      const open = (body.match(/\(/g) || []).length;
      const close = (body.match(/\)/g) || []).length;
      if (close > open) {
        end -= 1;
        continue;
      }
    }
    break;
  }
  return [url.slice(0, end), url.slice(end)];
}

/**
 * Turn bare http(s) URLs in the text of an HTML body into <a href> links.
 * Text inside existing <a>...</a> and inside tags (src, href, style) is left alone.
 * mapHref receives the decoded URL and returns the href to use.
 */
export function linkifyBareUrls(html, mapHref = (url) => url) {
  const parts = String(html || '').split(/(<a\b[\s\S]*?<\/a\s*>|<[^>]*>)/i);
  return parts
    .map((part, index) => {
      if (index % 2 === 1 || !part) {
        return part;
      }
      return part.replace(BARE_URL, (match) => {
        const [shown, trailing] = splitTrailing(match);
        if (!shown) {
          return match;
        }
        const href = mapHref(decodeEntities(shown));
        return `<a href="${escapeHtml(href)}">${shown}</a>${trailing}`;
      });
    })
    .join('');
}

function skipTracking(url, unsubscribeUrl) {
  return (
    url.includes('/t/') ||
    url.includes('/unsubscribe') ||
    (unsubscribeUrl && url.startsWith(unsubscribeUrl.split('?')[0])) ||
    url.startsWith(`${env.appUrl}/`)
  );
}

export function withEngagementTracking(html, { campaignId, recipientId, stepId, unsubscribeUrl, campaignName }) {
  if (!campaignId || !recipientId || recipientId === 'test') {
    // Test sends get real links and UTM tags, but no tracking so they never count.
    return linkifyBareUrls(html, (url) => (skipTracking(url, unsubscribeUrl) ? url : withUtm(url, campaignName)));
  }

  const src = openPixelUrl(campaignId, recipientId, stepId);
  const pixel = `<img src="${src}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;overflow:hidden" />`;

  const track = (url) =>
    skipTracking(url, unsubscribeUrl) ? url : clickUrl(campaignId, recipientId, withUtm(url, campaignName), stepId);

  const withHrefs = html.replace(/href=(["'])(https?:\/\/[^"']+)\1/gi, (full, quote, url) => {
    const decoded = decodeEntities(url);
    if (skipTracking(decoded, unsubscribeUrl)) {
      return full;
    }
    return `href="${escapeHtml(track(decoded))}"`;
  });

  const tracked = linkifyBareUrls(withHrefs, track);

  if (tracked.includes('/t/o/')) {
    return tracked;
  }

  return `${tracked}${pixel}`;
}
