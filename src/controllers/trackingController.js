import { asyncHandler } from '../middleware/asyncHandler.js';
import { applyEngagementEvent } from '../services/campaignService.js';
import { parseTrackingToken } from '../utils/tracking.js';
import { env } from '../config/env.js';

const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

function idsFromRequest(req) {
  const raw = String(req.params.token || '').replace(/\.gif$/i, '');
  return parseTrackingToken(raw);
}

function sendPixel(res) {
  res.set({
    'Content-Type': 'image/gif',
    'Content-Length': String(PIXEL.length),
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    Pragma: 'no-cache',
    Expires: '0',
  });
  res.end(PIXEL);
}

export const openPixel = asyncHandler(async (req, res) => {
  const ids = idsFromRequest(req);
  sendPixel(res);
  if (!ids) {
    return;
  }
  applyEngagementEvent({
    campaignId: ids.campaignId,
    recipientId: ids.recipientId,
    event: 'open',
  }).catch((err) => {
    console.error('[tracking] open failed', err.message);
  });
});

export const clickRedirect = asyncHandler(async (req, res) => {
  const ids = idsFromRequest(req);
  const target = String(req.query.u || '');
  const safe = /^https?:\/\//i.test(target) ? target : env.appUrl;

  if (ids) {
    applyEngagementEvent({
      campaignId: ids.campaignId,
      recipientId: ids.recipientId,
      event: 'click',
    }).catch((err) => {
      console.error('[tracking] click failed', err.message);
    });
  }

  res.redirect(302, safe);
});
