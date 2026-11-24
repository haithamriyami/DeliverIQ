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
import { runInBackground, canRunInBackground, sendRunBudgetMs } from '../utils/background.js';
import { runBackgroundSender } from '../services/backgroundSender.js';
import { syncAllInboxes } from '../services/inboxSync.js';
import {
  sendGridSettings,
  saveSendGridSettings,
  findSendGridAccount,
  SENDGRID_CAP_LIMITS,
  DEFAULT_SENDGRID_DAILY_CAP,
} from '../services/sendgridService.js';


function cronAuthorized(req) {
  if (!env.cronSecret) return false;
  const header = String(req.get('authorization') || '');
  const expected = `Bearer ${env.cronSecret}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Inbox sync for background runs. Throttled per account inside syncAllInboxes. */
export async function maybeSyncInbox() {
  try {
    return await syncAllInboxes();
  } catch (err) {
    return { error: err.message };
  }
}

/** Called by Vercel Cron (or any scheduler) with Authorization: Bearer CRON_SECRET. */
export const cronTick = asyncHandler(async (req, res) => {
  if (!cronAuthorized(req)) {
    throw new HttpError(401, 'Not authorized');
  }
  const run = runBackgroundSender({ budgetMs: () => sendRunBudgetMs(), beforeRun: maybeSyncInbox });
  if (runInBackground(run)) {
    // Answer at once; the run keeps going until close to the function deadline.
    return res.json({ ok: true, started: true });
  }
  res.json({ ok: true, ...(await run) });
});

/**
 * Make sure a background run is going. Used by the Send button and the open app.
 * On Vercel this returns at once and the run continues after the tab closes.
 * Elsewhere (local, Render) it only sends what is due now; the send loop does the rest.
 */
export function kickBackgroundSender() {
  if (!canRunInBackground()) return false;
  return runInBackground(runBackgroundSender({ budgetMs: () => sendRunBudgetMs() }));
}

/** Called by the open app every few seconds. Never waits for the gap itself. */
export const tick = asyncHandler(async (req, res) => {
  if (kickBackgroundSender()) {
    return res.json({ ok: true, background: true });
  }
  const result = await campaignService.runSchedulerTick({ budgetMs: 0 });
  // Only report sends of this workspace's campaigns.
  const sentIds = [...new Set(result.results.filter((row) => row.sent).map((row) => row.campaignId))];
  const mine = sentIds.length
    ? await prisma.campaign.findMany({ where: { id: { in: sentIds }, workspaceId: req.user.workspaceId }, select: { id: true } })
    : [];
  const ids = new Set(mine.map((row) => row.id));
  res.json({ ok: true, sent: result.results.filter((row) => row.sent && ids.has(row.campaignId)).length });
});

export const status = asyncHandler(async (req, res) => {
  res.json(await scheduler.sendingStatus(req.user.workspaceId));
});

const resumeSenderSchema = z.object({
  body: z.object({ accountId: z.string().uuid() }),
  params: z.any().optional(),
  query: z.any().optional(),
});

/** Resume a paused Gmail address. Only one linked in this workspace. */
export const resumeSender = [
  validate(resumeSenderSchema),
  asyncHandler(async (req, res) => {
    const { accountId } = req.validated.body;
    const sendgrid = await findSendGridAccount();
    if (sendgrid && sendgrid.id === accountId) {
      if (!(await sendGridSettings(req.user.workspaceId)).enabled) {
        throw new HttpError(404, 'Sender not found in this workspace');
      }
      if (req.user.role !== 'owner') {
        throw new HttpError(403, 'Only the workspace owner can resume SendGrid');
      }
      await scheduler.resumeSender(accountId);
      return res.json({ ok: true });
    }
    const links = await prisma.workspaceMember.findMany({
      where: { workspaceId: req.user.workspaceId, gmailAccountId: accountId },
      select: { userId: true },
    });
    if (!links.length) {
      throw new HttpError(404, 'Sender not found in this workspace');
    }
    if (req.user.role !== 'owner' && !links.some((link) => link.userId === req.user.id)) {
      throw new HttpError(403, 'Only the owner or the account holder can resume this sender');
    }
    await scheduler.resumeSender(accountId);
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
    await campaignService.getCampaignById(req.validated.params.id, req.user.workspaceId);
    await scheduler.resumeCampaign(req.validated.params.id);
    res.json({ ok: true });
  }),
];

export const pauseCampaign = [
  validate(campaignIdSchema),
  asyncHandler(async (req, res) => {
    await campaignService.getCampaignById(req.validated.params.id, req.user.workspaceId);
    await scheduler.pauseCampaign(req.validated.params.id, `Stopped by ${req.user.name}. Press Resume to continue.`);
    res.json({ ok: true });
  }),
];

const globalPauseSchema = z.object({
  body: z.object({ paused: z.boolean() }),
  params: z.any().optional(),
  query: z.any().optional(),
});

/** Kill switch: pause or resume all sending for the workspace. */
export const globalPause = [
  validate(globalPauseSchema),
  asyncHandler(async (req, res) => {
    const { paused } = req.validated.body;
    if (!paused && req.user.role !== 'owner') {
      throw new HttpError(403, 'Only the workspace owner can turn sending back on');
    }
    await scheduler.setGlobalPause(req.user.workspaceId, paused, paused ? `All sending paused by ${req.user.name}` : '');
    res.json({ ok: true, paused });
  }),
];

export const getSettings = asyncHandler(async (req, res) => {
  const ws = await prisma.workspace.findUnique({ where: { id: req.user.workspaceId } });
  res.json({
    ...normalizeSendSettings(ws || {}),
    fromDisplayName: ws?.fromDisplayName || '',
    replyToEmail: ws?.replyToEmail || '',
    defaultDisplayName: req.user.name,
    sendingPausedAt: ws?.sendingPausedAt || null,
    limits: SETTINGS_LIMITS,
    sendgrid: {
      ...(await sendGridSettings(req.user.workspaceId, { workspace: ws })),
      defaultDailyCap: DEFAULT_SENDGRID_DAILY_CAP,
      limits: SENDGRID_CAP_LIMITS,
      webhookUrl: `${env.appUrl}/webhooks/sendgrid`,
    },
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
    sendgrid: z
      .object({
        enabled: z.boolean().optional(),
        dailyCap: z.coerce.number().int().min(SENDGRID_CAP_LIMITS.min).max(SENDGRID_CAP_LIMITS.max).optional(),
        fromEmail: z.union([z.string().email(), z.literal('')]).optional(),
        fromName: z.string().max(80).optional(),
        replyToEmail: z.union([z.string().email(), z.literal('')]).optional(),
      })
      .optional(),
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
    if (body.sendgrid) {
      const sg = body.sendgrid;
      if (sg.fromName && sg.fromName.trim().toLowerCase() === 'deliveriq') {
        throw new HttpError(400, 'Use your own name or company name as the SendGrid sender name');
      }
      if (sg.enabled) {
        const current = await sendGridSettings(req.user.workspaceId);
        if (!current.keyConfigured) {
          throw new HttpError(400, 'SENDGRID_API_KEY is not set on the server, so SendGrid cannot be switched on yet.');
        }
        const from = sg.fromEmail != null ? sg.fromEmail : current.fromEmail;
        if (!from) {
          throw new HttpError(400, 'Enter the SendGrid From address before switching SendGrid on.');
        }
      }
    }
    if (Object.keys(data).length) {
      await prisma.workspace.update({ where: { id: req.user.workspaceId }, data });
    }
    if (body.sendgrid) {
      try {
        await saveSendGridSettings(req.user.workspaceId, body.sendgrid);
      } catch (err) {
        if (err.status === 503) throw new HttpError(503, err.message);
        throw err;
      }
    }
    res.json({ ok: true });
  }),
];

export const syncReplies = asyncHandler(async (req, res) => {
  res.json(await campaignService.syncRepliesFromGmail({ force: false, workspaceId: req.user.workspaceId }));
});
