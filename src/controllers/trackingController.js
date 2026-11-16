import { asyncHandler } from '../middleware/asyncHandler.js';
import { applyEngagementEvent } from '../services/campaignService.js';
import { parseTrackingToken } from '../utils/tracking.js';
import { runInBackground } from '../utils/background.js';
import { env } from '../config/env.js';

const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

/** How long an open or click waits for its database write before answering anyway. */
export const ENGAGEMENT_WRITE_TIMEOUT_MS = 4000;

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

/**
 * Save an open or click before the response goes out. On Vercel the function can be
 * frozen as soon as it answers, so a write started after the response is often lost.
 * The wait is capped so a slow database never leaves the reader hanging; when the cap
 * is hit the write is handed to waitUntil so it can still finish.
 */
export async function recordEngagement(ids, event, { apply = applyEngagementEvent, timeoutMs = ENGAGEMENT_WRITE_TIMEOUT_MS } = {}) {
  if (!ids) {
    return 'skipped';
  }
  const write = Promise.resolve()
    .then(() =>
      apply({
        campaignId: ids.campaignId,
        recipientId: ids.recipientId,
        stepId: ids.stepId,
        event,
      })
    )
    .then(() => 'saved')
    .catch((err) => {
      console.error(`[tracking] ${event} failed`, err?.message || err);
      return 'failed';
    });

  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const outcome = await Promise.race([write, timeout]);
  clearTimeout(timer);
  if (outcome === 'timeout') {
    console.warn(`[tracking] ${event} write still running after ${timeoutMs}ms`);
    runInBackground(write);
  }
  return outcome;
}

export const openPixel = asyncHandler(async (req, res) => {
  await recordEngagement(idsFromRequest(req), 'open');
  sendPixel(res);
});

export const clickRedirect = asyncHandler(async (req, res) => {
  const ids = idsFromRequest(req);
  const target = String(req.query.u || '');
  const safe = /^https?:\/\//i.test(target) ? target : env.appUrl;

  await recordEngagement(ids, 'click');
  res.redirect(302, safe);
});
