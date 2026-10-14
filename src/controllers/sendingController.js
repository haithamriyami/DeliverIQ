import { z } from 'zod';
import crypto from 'crypto';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validate } from '../middleware/validate.js';
import { HttpError } from '../middleware/errorHandler.js';
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import * as campaignService from '../services/campaignService.js';
import * as scheduler from '../services/sendScheduler.js';
import { SETTINGS_LIMITS, normalizeSendSettings } from '../utils/throttle.js';

const INBOX_SYNC_EVERY_MS = 10 * 60 * 1000;
const CRON_BUDGET_MS = 50 * 1000;

function cronAuthorized(req) {
  if (!env.cronSecret) return false;
  const header = String(req.get('authorization') || '');
  const expected = `Bearer ${env.cronSecret}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function maybeSyncInbox() {
  const stale = await prisma.user.findFirst({
    where: {
      gmailRefreshToken: { not: null },
      OR: [{ lastInboxSyncAt: null }, { lastInboxSyncAt: { lt: new Date(Date.now() - INBOX_SYNC_EVERY_MS) } }],
    },
  });
  if (!stale) return null;
  const out = {};
  try {
    out.replies = await campaignService.syncRepliesFromGmail();
  } catch (err) {
    out.repliesError = err.message;
  }
  try {
    out.bounces = await campaignService.syncBouncesFromGmail();
  } catch (err) {
    out.bouncesError = err.message;
  }
  return out;
}

/** Called by Vercel Cron (or any scheduler) with Authorization: Bearer CRON_SECRET. */
export const cronTick = asyncHandler(async (req, res) => {
  if (!cronAuthorized(req)) {
    throw new HttpError(401, 'Not authorized');
  }
  const inbox = await maybeSyncInbox();
  const tick = await campaignService.runSchedulerTick({ budgetMs: CRON_BUDGET_MS });
  res.json({ ok: true, inbox, ...tick });
});

/** Called by the open app every few seconds. Sends only what is due right now, never waits. */
export const tick = asyncHandler(async (_req, res) => {
  const result = await campaignService.runSchedulerTick({ budgetMs: 0 });
  res.json({ ok: true, sent: result.results.filter((row) => row.sent).length });
});

export const status = asyncHandler(async (_req, res) => {
  res.json(await scheduler.sendingStatus());
});

const resumeSenderSchema = z.object({
  body: z.object({ userId: z.string().uuid() }),
  params: z.any().optional(),
  query: z.any().optional(),
});

export const resumeSender = [
  validate(resumeSenderSchema),
  asyncHandler(async (req, res) => {
    const { userId } = req.validated.body;
    if (req.user.role !== 'owner' && req.user.id !== userId) {
      throw new HttpError(403, 'Only the owner or the account holder can resume this sender');
    }
    await scheduler.resumeSender(userId);
    res.json({ ok: true });
  }),
];

const campaignIdSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.any().optional(),
  query: z.any().optional(),
});

export const resumeCampaign = [
  validate(campaignIdSchema),
  asyncHandler(async (req, res) => {
    await scheduler.resumeCampaign(req.validated.params.id);
    res.json({ ok: true });
  }),
];

export const pauseCampaign = [
  validate(campaignIdSchema),
  asyncHandler(async (req, res) => {
    await scheduler.pauseCampaign(req.validated.params.id, `Stopped by ${req.user.name}. Press Resume to continue.`);
    res.json({ ok: true });
  }),
];

export const getSettings = asyncHandler(async (req, res) => {
  const ws = await prisma.workspace.findUnique({ where: { id: req.user.workspaceId } });
  res.json({
    ...normalizeSendSettings(ws || {}),
    fromDisplayName: ws?.fromDisplayName || '',
    replyToEmail: ws?.replyToEmail || '',
    defaultDisplayName: req.user.name,
    limits: SETTINGS_LIMITS,
  });
});

const L = SETTINGS_LIMITS;
const settingsSchema = z.object({
  body: z.object({
    sendGapSeconds: z.coerce.number().int().min(L.sendGapSeconds.min).max(L.sendGapSeconds.max).optional(),
    sendJitterSeconds: z.coerce.number().int().min(L.sendJitterSeconds.min).max(L.sendJitterSeconds.max).optional(),
    dailySendCap: z.coerce.number().int().min(L.dailySendCap.min).max(L.dailySendCap.max).optional(),
    fromDisplayName: z.string().max(80).optional(),
    replyToEmail: z.union([z.string().email(), z.literal('')]).optional(),
  }),
  params: z.any().optional(),
  query: z.any().optional(),
});

export const updateSettings = [
  validate(settingsSchema),
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'owner') {
      throw new HttpError(403, 'Only the workspace owner can change sending settings');
    }
    const body = req.validated.body;
    const data = {};
    for (const key of ['sendGapSeconds', 'sendJitterSeconds', 'dailySendCap']) {
      if (body[key] != null) data[key] = body[key];
    }
    if (body.fromDisplayName != null) {
      const name = body.fromDisplayName.replace(/[\r\n<>"]/g, '').trim();
      if (name.toLowerCase() === 'deliveriq') {
        throw new HttpError(400, 'Use your own name or company name as the sender name');
      }
      data.fromDisplayName = name || null;
    }
    if (body.replyToEmail != null) data.replyToEmail = body.replyToEmail || null;
    await prisma.workspace.update({ where: { id: req.user.workspaceId }, data });
    res.json({ ok: true });
  }),
];

export const syncReplies = asyncHandler(async (_req, res) => {
  res.json(await campaignService.syncRepliesFromGmail());
});
