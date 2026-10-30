/**
 * Throttled sender. Works on Vercel serverless:
 *
 * - Nothing sleeps for a whole campaign. Pressing Send only marks the step as queued.
 * - Each sender (connected Gmail account) has users.next_send_at in Postgres.
 *   Before every send we claim the slot with one atomic UPDATE
 *   (WHERE next_send_at IS NULL OR next_send_at <= now()), which also moves
 *   next_send_at forward by the gap (default 10 to 15 seconds). Two overlapping ticks (cron + browser)
 *   can never both send for the same account.
 * - runSendTick() sends at most one due email per sender, then, if the next slot
 *   still fits inside the time budget of this invocation, waits for it and repeats.
 *   With a 50 s budget a tick sends 1 or 2 emails per account and then exits.
 * - The daily cap counts campaign_recipients rows with sender_id = account and
 *   sent_at since Africa/Nairobi midnight. Over the cap, emails simply stay queued.
 */
import { prisma } from '../lib/prisma.js';
import { sendCampaignEmail, unsubscribeUrlFor } from './emailService.js';
import {
  computeNextSendAt,
  normalizeSendSettings,
  sendDayStart,
  nextSendDayStart,
  sendDecision,
  estimateFinish,
  emailsPerHour,
} from '../utils/throttle.js';
import { classifySendError, senderPauseMessage, isQuotaOnlyPauseReason, retryAfterMs, backoffMs, QUOTA_PAUSE_MARKERS } from '../utils/sendErrors.js';

export const BOUNCE_PAUSE_MIN_SENDS = 20;
export const BOUNCE_PAUSE_RATE = 0.05;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function workspaceSendSettings(workspaceId) {
  const ws = workspaceId
    ? await prisma.workspace.findUnique({ where: { id: workspaceId } })
    : await prisma.workspace.findFirst({ orderBy: { createdAt: 'asc' } });
  return normalizeSendSettings(ws || {});
}

/** Global kill switch for the sender's workspace. Read fresh from the database every time. */
export async function globalPauseFor(workspaceId) {
  const ws = workspaceId
    ? await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { sendingPausedAt: true } })
    : await prisma.workspace.findFirst({ where: { sendingPausedAt: { not: null } }, select: { sendingPausedAt: true } });
  return ws?.sendingPausedAt || null;
}

export async function setGlobalPause(workspaceId, paused, reason = '') {
  return prisma.workspace.update({
    where: { id: workspaceId },
    data: paused
      ? { sendingPausedAt: new Date(), sendingPausedReason: String(reason).slice(0, 500) }
      : { sendingPausedAt: null, sendingPausedReason: '' },
  });
}

/**
 * Last check right before Gmail is called, after the slot is claimed. Everything is
 * re-read from the database so a delete, Stop, pause, kill switch, reply, opt out or
 * unsubscribe that happened a moment ago always wins over work picked earlier in a tick.
 * Returns null if the send may go ahead, otherwise a reason string.
 */
export async function blockReasonAtSendTime({ senderId, workspaceId, stepId, campaignId, recipientId }) {
  const [sender, globalPaused, step, recipient, already] = await Promise.all([
    prisma.user.findUnique({ where: { id: senderId }, select: { sendingPausedAt: true, gmailRefreshToken: true } }),
    globalPauseFor(workspaceId),
    prisma.campaignStep.findUnique({
      where: { id: stepId },
      select: {
        status: true,
        stepNumber: true,
        campaignId: true,
        campaign: {
          select: {
            id: true,
            pausedAt: true,
            steps: { select: { stepNumber: true }, orderBy: { stepNumber: 'desc' }, take: 1 },
          },
        },
      },
    }),
    prisma.recipient.findUnique({ where: { id: recipientId } }),
    prisma.campaignRecipient.findUnique({ where: { stepId_recipientId: { stepId, recipientId } }, select: { id: true } }),
  ]);
  if (globalPaused) return 'global_paused';
  if (!sender?.gmailRefreshToken || sender.sendingPausedAt) return 'sender_paused';
  if (!step || !step.campaign || step.campaignId !== campaignId) return 'campaign_deleted';
  if (step.campaign.pausedAt) return 'campaign_paused';
  if (step.status !== 'sending') return 'step_not_queued';
  if (step.stepNumber !== (step.campaign.steps[0]?.stepNumber ?? step.stepNumber)) return 'step_superseded';
  if (!recipient) return 'recipient_deleted';
  if (recipient.status !== 'active' || recipient.doNotContact) return 'recipient_inactive';
  if (step.stepNumber > 1 && recipient.repliedAt) return 'recipient_replied';
  if (already) return 'already_sent';
  return null;
}

/** Give a claimed slot back when the final check stops the send, so the sender is not delayed. */
async function releaseSlot(senderId, previousNextSendAt) {
  await prisma.user.update({ where: { id: senderId }, data: { nextSendAt: previousNextSendAt || null } });
}

/** Which connected Gmail user sends for this campaign (mirrors getUserSender fallback). */
export async function resolveSenderUser(createdById) {
  if (createdById) {
    const owner = await prisma.user.findUnique({ where: { id: createdById } });
    if (owner?.gmailRefreshToken) return owner;
  }
  return prisma.user.findFirst({
    where: { gmailRefreshToken: { not: null } },
    orderBy: { createdAt: 'asc' },
  });
}

export async function sentTodayCount(senderId, now = new Date()) {
  return prisma.campaignRecipient.count({
    where: { senderId, sentAt: { gte: sendDayStart(now) } },
  });
}

/**
 * Atomically claim the next send slot for a sender. Returns true if this caller owns it.
 */
export async function claimSendSlot(senderId, settings, now = new Date()) {
  const next = computeNextSendAt(now, settings);
  const result = await prisma.user.updateMany({
    where: {
      id: senderId,
      sendingPausedAt: null,
      OR: [{ nextSendAt: null }, { nextSendAt: { lte: now } }],
    },
    data: { nextSendAt: next, lastSentAt: now },
  });
  return result.count === 1;
}

export async function pauseSender(senderId, reason) {
  await prisma.user.update({
    where: { id: senderId },
    data: { sendingPausedAt: new Date(), sendingPausedReason: String(reason).slice(0, 1000) },
  });
}

/**
 * Senders the old code paused only because of Gmail's per minute API quota (a read quota
 * hit by inbox scanning, shared with sending). That is not an account problem, so resume
 * them. Real pauses (policy, suspension, daily sending limit, reconnect) are kept.
 * Idempotent; runs on every scheduler tick and status read.
 */
export async function resumeQuotaPausedSenders() {
  const paused = await prisma.user.findMany({
    where: {
      sendingPausedAt: { not: null },
      OR: QUOTA_PAUSE_MARKERS.map((marker) => ({ sendingPausedReason: { contains: marker } })),
    },
    select: { id: true, sendingPausedReason: true },
  });
  const ids = paused.filter((u) => isQuotaOnlyPauseReason(u.sendingPausedReason)).map((u) => u.id);
  if (!ids.length) return 0;
  const result = await prisma.user.updateMany({
    where: { id: { in: ids }, sendingPausedAt: { not: null } },
    data: { sendingPausedAt: null, sendingPausedReason: '' },
  });
  return result.count;
}

/** Per minute quota on send: wait a bit (exponential, Retry-After honored), do not pause. */
export async function backOffSender(sender, err, now = new Date()) {
  const attempts = (sender.sendBackoffCount || 0) + 1;
  const wait = backoffMs(attempts, { baseMs: 60000, maxMs: 15 * 60000, retryAfter: retryAfterMs(err, now.getTime()) });
  const nextSendAt = new Date(now.getTime() + wait);
  await prisma.user.update({ where: { id: sender.id }, data: { nextSendAt, sendBackoffCount: attempts } });
  return nextSendAt;
}

export async function resumeSender(senderId) {
  return prisma.user.update({
    where: { id: senderId },
    data: { sendingPausedAt: null, sendingPausedReason: '' },
  });
}

export async function pauseCampaign(campaignId, reason) {
  await prisma.campaign.update({
    where: { id: campaignId },
    data: { pausedAt: new Date(), pausedReason: String(reason).slice(0, 1000) },
  });
}

export async function resumeCampaign(campaignId) {
  return prisma.campaign.update({
    where: { id: campaignId },
    data: { pausedAt: null, pausedReason: '' },
  });
}

/** Pure check used by the auto pause rule. */
export function shouldPauseForBounces({ attempted, bounced }) {
  return attempted >= BOUNCE_PAUSE_MIN_SENDS && bounced / attempted > BOUNCE_PAUSE_RATE;
}

/** Pause a campaign whose hard bounce rate is over 5% after at least 20 sends. */
export async function checkCampaignBounceRate(campaignId) {
  const grouped = await prisma.campaignRecipient.groupBy({
    by: ['status'],
    where: { campaignId },
    _count: { _all: true },
  });
  let attempted = 0;
  let bounced = 0;
  for (const row of grouped) {
    attempted += row._count._all;
    if (row.status === 'bounced') bounced += row._count._all;
  }
  if (!shouldPauseForBounces({ attempted, bounced })) return false;
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { pausedAt: true } });
  if (campaign?.pausedAt) return false;
  const rate = Math.round((bounced / attempted) * 1000) / 10;
  await pauseCampaign(
    campaignId,
    `Paused automatically: ${bounced} of ${attempted} emails bounced (${rate}%), above the 5% limit. Clean the list, then press Resume.`
  );
  return true;
}

/**
 * Steps the scheduler may send. Only the latest step of each campaign counts: an older
 * step left in "sending" (for example Email 1 abandoned before a follow-up was added, from
 * the old batch sender) must never be picked up silently, because the campaign table only
 * shows the latest step and those sends were invisible.
 */
export async function queuedSteps() {
  const steps = await prisma.campaignStep.findMany({
    where: {
      status: 'sending',
      campaign: { pausedAt: null },
    },
    include: {
      template: true,
      campaign: {
        include: {
          template: true,
          steps: { select: { stepNumber: true }, orderBy: { stepNumber: 'desc' }, take: 1 },
        },
      },
    },
    orderBy: [{ createdAt: 'asc' }, { stepNumber: 'asc' }],
  });
  return steps.filter((step) => step.stepNumber === (step.campaign.steps[0]?.stepNumber ?? step.stepNumber));
}

/**
 * Find the next recipient to send for this sender, across all queued campaigns and follow-ups.
 * Oldest campaign first, Email 1 before follow-ups.
 */
export async function nextPendingForSender(sender) {
  const steps = await queuedSteps();

  for (const step of steps) {
    const owner = await resolveSenderUser(step.campaign.createdById);
    if (!owner || owner.id !== sender.id) continue;

    const audience = step.recipientIds?.length ? step.recipientIds : step.campaign.recipientIds;
    if (!audience.length) continue;

    const processed = await prisma.campaignRecipient.findMany({
      where: { stepId: step.id },
      select: { recipientId: true },
    });
    const done = new Set(processed.map((row) => row.recipientId));
    const candidates = await prisma.recipient.findMany({
      where: {
        id: { in: audience },
        status: 'active',
        doNotContact: false,
        ...(step.stepNumber > 1 ? { repliedAt: null } : {}),
      },
      orderBy: { email: 'asc' },
    });
    const recipient = candidates.find((row) => !done.has(row.id));
    if (recipient) {
      return { step, campaign: step.campaign, recipient };
    }
  }
  return null;
}

export async function queuedCountForSender(sender) {
  const steps = await queuedSteps();
  let total = 0;
  for (const step of steps) {
    const owner = await resolveSenderUser(step.campaign.createdById);
    if (!owner || owner.id !== sender.id) continue;
    const audience = step.recipientIds?.length ? step.recipientIds : step.campaign.recipientIds;
    const [processed, candidates] = await Promise.all([
      prisma.campaignRecipient.findMany({ where: { stepId: step.id }, select: { recipientId: true } }),
      prisma.recipient.findMany({
        where: {
          id: { in: audience },
          status: 'active',
          doNotContact: false,
          ...(step.stepNumber > 1 ? { repliedAt: null } : {}),
        },
        select: { id: true },
      }),
    ]);
    const done = new Set(processed.map((row) => row.recipientId));
    total += candidates.filter((row) => !done.has(row.id)).length;
  }
  return total;
}

/**
 * Try to send exactly one email for this sender. Returns a result describing what happened.
 * Injected deps make this testable without Gmail.
 */
export async function sendOneForSender(sender, settings, { now = new Date(), send = sendCampaignEmail, hooks = {} } = {}) {
  const sentToday = await sentTodayCount(sender.id, now);
  const decision = sendDecision({
    now,
    nextSendAt: sender.nextSendAt,
    sentToday,
    settings,
    pausedAt: sender.sendingPausedAt || (await globalPauseFor(sender.workspaceId)),
  });
  if (!decision.ok) {
    return { sent: false, reason: decision.reason, retryAt: decision.retryAt };
  }

  const work = await nextPendingForSender(sender);
  if (!work) {
    return { sent: false, reason: 'idle', retryAt: null };
  }

  const claimed = await claimSendSlot(sender.id, settings, now);
  if (!claimed) {
    return { sent: false, reason: 'gap', retryAt: null };
  }

  const { step, campaign, recipient } = work;
  const blocked = await blockReasonAtSendTime({
    senderId: sender.id,
    workspaceId: sender.workspaceId,
    stepId: step.id,
    campaignId: campaign.id,
    recipientId: recipient.id,
  });
  if (blocked) {
    await releaseSlot(sender.id, sender.nextSendAt);
    console.log(`[send] skipped ${recipient.email}: ${blocked}`);
    return { sent: false, reason: blocked, retryAt: null };
  }

  let result;
  try {
    result = await send({
      to: recipient.email,
      name: recipient.name,
      subject: step.subject,
      html: (step.template || campaign.template).body,
      campaignId: campaign.id,
      recipientId: recipient.id,
      stepId: step.id,
      unsubscribeUrl: unsubscribeUrlFor(recipient.unsubscribeToken),
      userId: sender.id,
    });
  } catch (err) {
    return handleSendError(err, { sender, campaign, step, recipient, hooks });
  }

  if (sender.sendBackoffCount) {
    await prisma.user.update({ where: { id: sender.id }, data: { sendBackoffCount: 0 } }).catch(() => {});
  }

  // The email is out. Recording must never be mistaken for a send failure: if the campaign
  // was deleted in the moment between the final check and now, just log it.
  try {
    await hooks.recordSend?.({
      campaignId: campaign.id,
      recipientId: recipient.id,
      stepId: step.id,
      messageId: result?.messageId,
      threadId: result?.threadId,
      senderId: sender.id,
    });
    await hooks.maybeCompleteCampaign?.(campaign.id, step.id);
  } catch (err) {
    console.error(`[send] sent to ${recipient.email} but could not record it: ${err.message}`);
  }
  return { sent: true, campaignId: campaign.id, stepId: step.id, email: recipient.email };
}

async function handleSendError(err, { sender, campaign, step, recipient, hooks }) {
  {
    const kind = classifySendError(err);
    console.error(`[send] ${kind} for ${recipient.email}: ${err.message}`);
    if (kind === 'transient') {
      const retryAt = await backOffSender(sender, err);
      return { sent: false, reason: 'backoff', retryAt, error: err.message };
    }
    if (kind === 'sender_block' || kind === 'auth') {
      await pauseSender(sender.id, senderPauseMessage(kind, err));
      return { sent: false, reason: 'sender_paused', error: err.message };
    }
    await hooks.recordBounce?.({
      campaignId: campaign.id,
      recipientId: recipient.id,
      stepId: step.id,
      error: err.message,
      senderId: sender.id,
    });
    await checkCampaignBounceRate(campaign.id);
    await hooks.maybeCompleteCampaign?.(campaign.id, step.id);
    return { sent: false, reason: 'bounced', email: recipient.email, error: err.message };
  }
}

/**
 * One scheduler tick. Sends due emails for every connected sender, then waits for the
 * next due slot only if it fits inside budgetMs. Safe to call concurrently.
 */
export async function runSendTick({ budgetMs = 0, hooks } = {}) {
  const startedAt = Date.now();
  const results = [];
  const settings = await workspaceSendSettings();

  await resumeQuotaPausedSenders();
  for (;;) {
    if (await globalPauseFor()) break;
    const senders = await prisma.user.findMany({
      where: { gmailRefreshToken: { not: null }, sendingPausedAt: null },
    });
    let earliest = null;
    let anyWork = false;
    for (const sender of senders) {
      const result = await sendOneForSender(sender, settings, { now: new Date(), hooks });
      results.push({ sender: sender.gmailEmail, ...result });
      if (result.reason && result.reason !== 'gap' && result.reason !== 'bounced') {
        // idle, cap, paused, or stopped by the final check: nothing to wait for this tick.
        continue;
      }
      anyWork = true;
      const fresh = await prisma.user.findUnique({ where: { id: sender.id }, select: { nextSendAt: true } });
      const at = fresh?.nextSendAt?.getTime() ?? Date.now();
      earliest = earliest == null ? at : Math.min(earliest, at);
    }
    if (!anyWork || earliest == null) break;
    const elapsed = Date.now() - startedAt;
    const wait = Math.max(0, earliest - Date.now()) + 250;
    if (elapsed + wait > budgetMs) break;
    await sleep(wait);
  }

  return { ranMs: Date.now() - startedAt, results };
}

/** Per sender status for the UI: sent today, queued, cap, next send, pause banner. */
export async function sendingStatus() {
  await resumeQuotaPausedSenders();
  const settings = await workspaceSendSettings();
  const now = new Date();
  const senders = await prisma.user.findMany({
    where: { gmailRefreshToken: { not: null } },
    orderBy: { createdAt: 'asc' },
  });
  const rows = [];
  for (const sender of senders) {
    const [sentToday, queued] = await Promise.all([sentTodayCount(sender.id, now), queuedCountForSender(sender)]);
    rows.push({
      userId: sender.id,
      email: sender.gmailEmail,
      name: sender.name,
      sentToday,
      queued,
      dailyCap: settings.dailySendCap,
      capReached: sentToday >= settings.dailySendCap,
      resumesAt: sentToday >= settings.dailySendCap ? nextSendDayStart(now) : null,
      estimatedFinish: sender.sendingPausedAt
        ? null
        : estimateFinish({ now, queued, sentToday, nextSendAt: sender.nextSendAt, settings }),
      emailsPerHour: emailsPerHour(settings),
      nextSendAt: sender.nextSendAt,
      inboxNotice: sender.inboxSyncNotice || '',
      inboxLastSyncAt: sender.lastInboxSyncAt,
      paused: Boolean(sender.sendingPausedAt),
      pausedAt: sender.sendingPausedAt,
      pausedReason: sender.sendingPausedReason,
    });
  }
  const ws = await prisma.workspace.findFirst({ orderBy: { createdAt: 'asc' }, select: { sendingPausedAt: true, sendingPausedReason: true } });
  const pausedCampaigns = await prisma.campaign.findMany({
    where: { pausedAt: { not: null } },
    select: { id: true, name: true, pausedAt: true, pausedReason: true },
  });
  return {
    settings,
    senders: rows,
    pausedCampaigns,
    globalPause: ws?.sendingPausedAt ? { pausedAt: ws.sendingPausedAt, reason: ws.sendingPausedReason } : null,
  };
}
