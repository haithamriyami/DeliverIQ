/**
 * Throttled sender. Works on Vercel serverless:
 *
 * - Nothing sleeps for a whole campaign. Pressing Send only marks the step as queued.
 * - Each sender (connected Gmail address) has gmail_accounts.next_send_at in Postgres.
 *   Before every send we claim the slot with one atomic UPDATE
 *   (WHERE next_send_at IS NULL OR next_send_at <= now()), which also moves
 *   next_send_at forward by the gap (default 10 to 15 seconds). Two overlapping ticks (cron + browser)
 *   can never both send for the same account.
 * - runSendTick() sends at most one due email per sender, then, if the next slot
 *   still fits inside the time budget of this invocation, waits for it and repeats.
 *   With a 50 s budget a tick sends 1 or 2 emails per account and then exits.
 * - The daily cap counts campaign_recipients rows with sender_account_id = account and
 *   sent_at in the last 24 hours (rolling, like Gmail's own limit). Over the cap, emails
 *   simply stay queued until the oldest of those sends is 24 hours old.
 * - If Gmail itself says the daily sending limit is reached, the account is held (not
 *   paused) until room frees up, with a note the app shows. No retry loop, no bounce.
 * - Workspaces: Gmail is connected per workspace. Each workspace member links the Gmail
 *   they send from in that workspace (workspace_members.gmail_account_id), so one login can
 *   send from one address in FinanceBridge and another in a personal workspace. A campaign
 *   only ever sends from a Gmail linked in its own workspace.
 * - If the same Gmail address is linked in two workspaces, both use the same
 *   gmail_accounts row, so the gap and the daily count stay shared per address and can
 *   never be broken. The gap length, jitter and cap number come from the settings of the
 *   workspace whose email is being sent. The kill switch is per workspace.
 * - SendGrid is a second sender a workspace owner can switch on in Settings (off by
 *   default). It has one shared gmail_accounts row (email "sendgrid") for its gap, rolling
 *   24 hour count and holds, and its own daily cap. Gmail and SendGrid work through the
 *   same queue side by side, each at its own pace and within its own cap, so sending is
 *   shared between them instead of SendGrid only being a fallback. A short claim row per
 *   recipient (scheduler_leases, "claim:<step>:<recipient>") makes sure two senders never
 *   pick the same contact at the same moment.
 */
import { prisma } from '../lib/prisma.js';
import { sendCampaignEmail, unsubscribeUrlFor } from './emailService.js';
import {
  computeNextSendAt,
  normalizeSendSettings,
  sendWindowStart,
  SEND_WINDOW_MS,
  sendDecision,
  estimateFinish,
  emailsPerHour,
  formatSendTime,
} from '../utils/throttle.js';
import {
  classifySendError,
  senderPauseMessage,
  isQuotaOnlyPauseReason,
  retryAfterMs,
  backoffMs,
  gmailRetryAt,
  QUOTA_PAUSE_MARKERS,
  DAILY_LIMIT_MARKER,
} from '../utils/sendErrors.js';
import {
  isSendGridAccount,
  sendGridSettings,
  sendGridReady,
  sendGridWorkspaceIds,
  findSendGridAccount,
  classifySendGridError,
  sendGridPauseMessage,
  SENDGRID_LIMIT_MARKER,
} from './sendgridService.js';

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
export async function blockReasonAtSendTime({ senderId, workspaceId, stepId, campaignId, recipientId, sendgrid = false }) {
  if (!workspaceId) {
    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { workspaceId: true } });
    if (!campaign) return 'campaign_deleted';
    workspaceId = campaign.workspaceId;
  }
  const [sender, globalPaused, step, recipient, already, member] = await Promise.all([
    prisma.gmailAccount.findUnique({ where: { id: senderId }, select: { sendingPausedAt: true, refreshToken: true, email: true } }),
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
            workspaceId: true,
            pausedAt: true,
            steps: { select: { stepNumber: true }, orderBy: { stepNumber: 'desc' }, take: 1 },
          },
        },
      },
    }),
    prisma.recipient.findUnique({ where: { id: recipientId } }),
    prisma.campaignRecipient.findUnique({ where: { stepId_recipientId: { stepId, recipientId } }, select: { id: true } }),
    prisma.workspaceMember.findFirst({ where: { workspaceId, gmailAccountId: senderId }, select: { id: true } }),
  ]);
  if (globalPaused) return 'global_paused';
  if (sendgrid) {
    if (!sender || sender.sendingPausedAt) return 'sender_paused';
    if (!sendGridReady(await sendGridSettings(workspaceId))) return 'sender_not_in_workspace';
  } else if (!sender?.refreshToken || sender.sendingPausedAt) return 'sender_paused';
  if (!step || !step.campaign || step.campaignId !== campaignId) return 'campaign_deleted';
  if (step.campaign.workspaceId !== workspaceId) return 'workspace_mismatch';
  if (!sendgrid && !member) return 'sender_not_in_workspace';
  if (step.campaign.pausedAt) return 'campaign_paused';
  if (step.status !== 'sending') return 'step_not_queued';
  if (step.stepNumber !== (step.campaign.steps[0]?.stepNumber ?? step.stepNumber)) return 'step_superseded';
  if (!recipient) return 'recipient_deleted';
  if (recipient.workspaceId !== workspaceId) return 'workspace_mismatch';
  if (recipient.status !== 'active' || recipient.doNotContact) return 'recipient_inactive';
  if (step.stepNumber > 1 && recipient.repliedAt) return 'recipient_replied';
  if (already) return 'already_sent';
  return null;
}

/** Give a claimed slot back when the final check stops the send, so the sender is not delayed. */
async function releaseSlot(senderId, previousNextSendAt) {
  await prisma.gmailAccount.update({ where: { id: senderId }, data: { nextSendAt: previousNextSendAt || null } });
}

/**
 * Which Gmail sends for this campaign: the one its creator linked in the campaign's
 * workspace, otherwise the one a workspace owner linked, otherwise any member's. Only
 * Gmail linked in this workspace is ever used. Returns the gmail_accounts row plus
 * userId (the member it is linked through), or null.
 */
export async function resolveSender(createdById, workspaceId) {
  if (!workspaceId) return null;
  const members = await prisma.workspaceMember.findMany({
    where: { workspaceId, gmailAccount: { refreshToken: { not: null } } },
    include: { gmailAccount: true },
    orderBy: { createdAt: 'asc' },
  });
  const pick =
    (createdById && members.find((row) => row.userId === createdById)) ||
    members.find((row) => row.role === 'owner') ||
    members[0];
  return pick ? { ...pick.gmailAccount, userId: pick.userId } : null;
}

/** Old name, kept for callers and tests. */
export const resolveSenderUser = resolveSender;

/** Gmail linked by this member in this workspace (with a token), or null. */
export async function memberSender(userId, workspaceId) {
  const member = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    include: { gmailAccount: true },
  });
  return member?.gmailAccount?.refreshToken ? { ...member.gmailAccount, userId } : null;
}

async function accountRow(account) {
  if (account && typeof account === 'object') return account;
  return account ? prisma.gmailAccount.findUnique({ where: { id: account } }) : null;
}

function windowWhere(row, now, workspaceId) {
  const legacy = row.connectedById ? [{ senderAccountId: null, senderId: row.connectedById }] : [];
  return {
    sentAt: { gt: sendWindowStart(now) },
    OR: [{ senderAccountId: row.id }, ...legacy],
    ...(workspaceId ? { campaign: { workspaceId } } : {}),
  };
}

/**
 * Emails sent from one Gmail address in the last 24 hours, in every workspace. This is the
 * number the daily cap uses (the name is kept for the API). Sends recorded before
 * sender_account_id existed are counted through the user who connected the address.
 */
export async function sentTodayCount(account, now = new Date(), { workspaceId } = {}) {
  const row = await accountRow(account);
  if (!row) return 0;
  return prisma.campaignRecipient.count({ where: windowWhere(row, now, workspaceId) });
}

/**
 * When the rolling 24 hour cap has room again: the moment the send that keeps the count
 * at the cap turns 24 hours old. Below the cap it is when the oldest send in the window
 * ages out (useful for estimates). Null when nothing was sent in the last 24 hours.
 */
export async function capResumesAt(account, cap, now = new Date(), { sentInWindow } = {}) {
  const row = await accountRow(account);
  if (!row) return null;
  const where = windowWhere(row, now);
  const count = sentInWindow ?? (await prisma.campaignRecipient.count({ where }));
  if (!count) return null;
  const skip = Math.max(0, count - Math.max(1, cap));
  const oldest = await prisma.campaignRecipient.findFirst({
    where,
    orderBy: { sentAt: 'asc' },
    skip,
    select: { sentAt: true },
  });
  return oldest?.sentAt ? new Date(oldest.sentAt.getTime() + SEND_WINDOW_MS) : null;
}

/** A note written by holdSenderForDailyLimit (Gmail's or SendGrid's daily limit). */
export function isHoldNote(reason) {
  const text = String(reason || '');
  return text.startsWith(DAILY_LIMIT_MARKER) || text.startsWith(SENDGRID_LIMIT_MARKER);
}

/** Is this account held because Gmail (or SendGrid) reported its daily sending limit? */
export function dailyLimitHold(sender, now = new Date()) {
  if (!sender || sender.sendingPausedAt) return null;
  if (!isHoldNote(sender.sendingPausedReason)) return null;
  if (!sender.nextSendAt || sender.nextSendAt <= now) return null;
  return { until: sender.nextSendAt, reason: sender.sendingPausedReason };
}

/** Hold an account after Gmail's daily limit error, for at least an hour and at most 24. */
export const DAILY_LIMIT_MIN_HOLD_MS = 60 * 60 * 1000;

/**
 * Gmail said the daily sending limit is reached. Hold the account (no pause, so it
 * resumes by itself) until the later of Gmail's retry time and the time the oldest send
 * of the last 24 hours ages out. Gmail's own retry time is often only minutes away and
 * then fails again, so it is never trusted alone.
 */
export async function holdSenderForDailyLimit(sender, err, now = new Date()) {
  const gmailAt = gmailRetryAt(err, now.getTime());
  // Room frees up when the oldest send of the last 24 hours ages out.
  const windowAt = await capResumesAt(sender, Number.MAX_SAFE_INTEGER, now);
  let until = Math.max(now.getTime() + DAILY_LIMIT_MIN_HOLD_MS, gmailAt?.getTime() || 0, windowAt?.getTime() || 0);
  until = Math.min(until, now.getTime() + SEND_WINDOW_MS);
  const nextSendAt = new Date(until);
  const detail = String(err?.message || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const sendgrid = isSendGridAccount(sender);
  const marker = sendgrid ? SENDGRID_LIMIT_MARKER : DAILY_LIMIT_MARKER;
  await prisma.gmailAccount.update({
    where: { id: sender.id },
    data: {
      nextSendAt,
      sendBackoffCount: 0,
      sendingPausedReason: `${marker}. Sending resumes by itself at ${formatSendTime(nextSendAt)}. ${sendgrid ? 'SendGrid' : 'Gmail'} said: ${detail}`.slice(0, 1000),
    },
  });
  return nextSendAt;
}

/**
 * Atomically claim the next send slot for a sender. Returns true if this caller owns it.
 */
export async function claimSendSlot(senderId, settings, now = new Date()) {
  const next = computeNextSendAt(now, settings);
  const result = await prisma.gmailAccount.updateMany({
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
  await prisma.gmailAccount.update({
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
  const paused = await prisma.gmailAccount.findMany({
    where: {
      sendingPausedAt: { not: null },
      OR: QUOTA_PAUSE_MARKERS.map((marker) => ({ sendingPausedReason: { contains: marker } })),
    },
    select: { id: true, sendingPausedReason: true },
  });
  const ids = paused.filter((u) => isQuotaOnlyPauseReason(u.sendingPausedReason)).map((u) => u.id);
  if (!ids.length) return 0;
  const result = await prisma.gmailAccount.updateMany({
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
  await prisma.gmailAccount.update({ where: { id: sender.id }, data: { nextSendAt, sendBackoffCount: attempts } });
  return nextSendAt;
}

export async function resumeSender(senderId) {
  return prisma.gmailAccount.update({
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
export async function queuedSteps({ pausedWorkspaces = false } = {}) {
  const steps = await prisma.campaignStep.findMany({
    where: {
      status: 'sending',
      campaign: {
        pausedAt: null,
        // Workspaces with the kill switch on are skipped, so they never block other workspaces.
        workspace: { sendingPausedAt: pausedWorkspaces ? { not: null } : null },
      },
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

export const RECIPIENT_CLAIM_MS = 2 * 60 * 1000;

function claimName(stepId, recipientId) {
  return `claim:${stepId}:${recipientId}`;
}

/**
 * Claim one contact of one step for this sender, so a second sender working the same queue
 * at the same moment picks someone else. Expired claims (a crashed run) can be taken over.
 */
export async function claimRecipient(stepId, recipientId, holder, now = new Date()) {
  const name = claimName(stepId, recipientId);
  const expiresAt = new Date(now.getTime() + RECIPIENT_CLAIM_MS);
  try {
    await prisma.schedulerLease.create({ data: { name, holder, expiresAt } });
    return true;
  } catch {
    // Someone holds it: take it only if that claim has expired.
  }
  const result = await prisma.schedulerLease.updateMany({
    where: { name, OR: [{ expiresAt: { lt: now } }, { holder }] },
    data: { holder, expiresAt },
  });
  return result.count === 1;
}

export async function releaseRecipientClaim(stepId, recipientId, holder) {
  await prisma.schedulerLease.deleteMany({ where: { name: claimName(stepId, recipientId), holder } }).catch(() => {});
}

/** Contacts of this step another sender is working on right now. */
async function claimedByOthers(stepId, holder, now = new Date()) {
  const rows = await prisma.schedulerLease.findMany({
    where: { name: { startsWith: `claim:${stepId}:` }, expiresAt: { gt: now }, NOT: { holder } },
    select: { name: true },
  });
  return new Set(rows.map((row) => row.name.slice(`claim:${stepId}:`.length)));
}

/**
 * May this sender send this step? Gmail: only the Gmail resolveSender picks for the
 * campaign. SendGrid: when it is switched on for the campaign's workspace.
 * Returns { senderUserId } or null.
 */
async function senderServesStep(sender, step, sendGridIds) {
  if (isSendGridAccount(sender)) {
    if (!sendGridIds.has(step.campaign.workspaceId)) return null;
    return { senderUserId: step.campaign.createdById || null };
  }
  const owner = await resolveSender(step.campaign.createdById, step.campaign.workspaceId);
  if (!owner || owner.id !== sender.id) return null;
  return { senderUserId: owner.userId };
}

async function sendGridIdSet(sender) {
  return isSendGridAccount(sender) ? new Set(await sendGridWorkspaceIds()) : new Set();
}

/**
 * Find the next recipient to send for this sender, across all queued campaigns and follow-ups.
 * Oldest campaign first, Email 1 before follow-ups.
 */
export async function nextPendingForSender(sender, { pausedWorkspaces = false } = {}) {
  const steps = await queuedSteps({ pausedWorkspaces });
  const sendGridIds = await sendGridIdSet(sender);

  for (const step of steps) {
    const serves = await senderServesStep(sender, step, sendGridIds);
    if (!serves) continue;

    const audience = step.recipientIds?.length ? step.recipientIds : step.campaign.recipientIds;
    if (!audience.length) continue;

    const processed = await prisma.campaignRecipient.findMany({
      where: { stepId: step.id },
      select: { recipientId: true },
    });
    const done = new Set(processed.map((row) => row.recipientId));
    for (const id of await claimedByOthers(step.id, sender.id)) done.add(id);
    const candidates = await prisma.recipient.findMany({
      where: {
        id: { in: audience },
        workspaceId: step.campaign.workspaceId,
        status: 'active',
        doNotContact: false,
        ...(step.stepNumber > 1 ? { repliedAt: null } : {}),
      },
      orderBy: { email: 'asc' },
    });
    const recipient = candidates.find((row) => !done.has(row.id));
    if (recipient) {
      return { step, campaign: step.campaign, recipient, senderUserId: serves.senderUserId };
    }
  }
  return null;
}

export async function queuedCountForSender(sender, workspaceId) {
  const steps = await queuedSteps();
  const sendGridIds = await sendGridIdSet(sender);
  let total = 0;
  for (const step of steps) {
    if (workspaceId && step.campaign.workspaceId !== workspaceId) continue;
    if (!(await senderServesStep(sender, step, sendGridIds))) continue;
    const audience = step.recipientIds?.length ? step.recipientIds : step.campaign.recipientIds;
    const [processed, candidates] = await Promise.all([
      prisma.campaignRecipient.findMany({ where: { stepId: step.id }, select: { recipientId: true } }),
      prisma.recipient.findMany({
        where: {
          id: { in: audience },
          workspaceId: step.campaign.workspaceId,
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
  // Gap and sender pause do not depend on the workspace, so check them before any work lookup.
  if (sender.sendingPausedAt) {
    return { sent: false, reason: 'paused', retryAt: null };
  }
  if (sender.nextSendAt && sender.nextSendAt > now) {
    return { sent: false, reason: 'gap', retryAt: sender.nextSendAt };
  }

  const work = await nextPendingForSender(sender);
  if (!work) {
    // Only work in workspaces with the kill switch on: report it as paused.
    const held = await nextPendingForSender(sender, { pausedWorkspaces: true });
    return { sent: false, reason: held ? 'paused' : 'idle', retryAt: null };
  }

  // The gap length and cap come from the workspace being sent for; the count of emails
  // sent today is per Gmail account across every workspace. SendGrid uses the workspace's
  // gap and its own daily cap from the SendGrid settings.
  const sendgrid = isSendGridAccount(sender);
  settings = settings || (await workspaceSendSettings(work.campaign.workspaceId));
  if (sendgrid) {
    const sg = await sendGridSettings(work.campaign.workspaceId);
    settings = { ...settings, dailySendCap: sg.dailyCap };
  }
  const sentToday = await sentTodayCount(sender, now);
  const decision = sendDecision({
    now,
    nextSendAt: sender.nextSendAt,
    sentToday,
    settings,
    capResumesAt: sentToday >= normalizeSendSettings(settings).dailySendCap
      ? await capResumesAt(sender, normalizeSendSettings(settings).dailySendCap, now, { sentInWindow: sentToday })
      : null,
    pausedAt: sender.sendingPausedAt || (await globalPauseFor(work.campaign.workspaceId)),
  });
  if (!decision.ok) {
    return { sent: false, reason: decision.reason, retryAt: decision.retryAt };
  }

  const claimed = await claimSendSlot(sender.id, settings, now);
  if (!claimed) {
    return { sent: false, reason: 'gap', retryAt: null };
  }

  const { step, campaign, recipient } = work;
  if (!(await claimRecipient(step.id, recipient.id, sender.id, now))) {
    // Another sender took this contact a moment ago. Try again with the next one.
    await releaseSlot(sender.id, sender.nextSendAt);
    return { sent: false, reason: 'gap', retryAt: null };
  }
  try {
    return await sendClaimed({ sender, settings, work, send, hooks, sendgrid });
  } finally {
    await releaseRecipientClaim(step.id, recipient.id, sender.id);
  }
}

async function sendClaimed({ sender, work, send, hooks, sendgrid }) {
  const { step, campaign, recipient } = work;
  const blocked = await blockReasonAtSendTime({
    senderId: sender.id,
    workspaceId: campaign.workspaceId,
    stepId: step.id,
    campaignId: campaign.id,
    recipientId: recipient.id,
    sendgrid,
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
      organization: recipient.organization,
      subject: step.subject,
      html: (step.template || campaign.template).body,
      campaignId: campaign.id,
      recipientId: recipient.id,
      stepId: step.id,
      unsubscribeUrl: unsubscribeUrlFor(recipient.unsubscribeToken),
      accountId: sender.id,
      userId: work.senderUserId,
      campaignName: campaign.name,
      workspaceId: campaign.workspaceId,
      provider: sendgrid ? 'sendgrid' : 'gmail',
    });
  } catch (err) {
    return handleSendError(err, { sender, campaign, step, recipient, hooks, senderUserId: work.senderUserId });
  }

  const heldNote = !sender.sendingPausedAt && isHoldNote(sender.sendingPausedReason);
  if (sender.sendBackoffCount || heldNote) {
    await prisma.gmailAccount
      .update({ where: { id: sender.id }, data: { sendBackoffCount: 0, ...(heldNote ? { sendingPausedReason: '' } : {}) } })
      .catch(() => {});
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
      senderId: work.senderUserId,
      senderAccountId: sender.id,
    });
    await hooks.maybeCompleteCampaign?.(campaign.id, step.id);
  } catch (err) {
    console.error(`[send] sent to ${recipient.email} but could not record it: ${err.message}`);
  }
  return { sent: true, campaignId: campaign.id, stepId: step.id, email: recipient.email, provider: sendgrid ? 'sendgrid' : 'gmail' };
}

async function handleSendError(err, { sender, campaign, step, recipient, hooks, senderUserId }) {
  {
    const sendgrid = isSendGridAccount(sender);
    const kind = sendgrid ? classifySendGridError(err) : classifySendError(err);
    console.error(`[send] ${kind} for ${recipient.email}: ${err.message}`);
    if (kind === 'transient') {
      const retryAt = await backOffSender(sender, err);
      return { sent: false, reason: 'backoff', retryAt, error: err.message };
    }
    if (kind === 'daily_limit') {
      // The contact did nothing wrong: no bounce, no row, no lastError. It stays queued.
      const retryAt = await holdSenderForDailyLimit(sender, err);
      return { sent: false, reason: 'daily_limit', retryAt, error: err.message };
    }
    if (kind === 'sender_block' || kind === 'auth') {
      await pauseSender(sender.id, sendgrid ? sendGridPauseMessage(err) : senderPauseMessage(kind, err));
      return { sent: false, reason: 'sender_paused', error: err.message };
    }
    if (kind !== 'recipient') {
      // Sender side or API failure. There is no failed campaign_recipients status, and
      // creating a row would block a later retry (already_sent) and could count as a bounce.
      // Leave the contact queued and active, and store the message on lastError only.
      await prisma.recipient.update({
        where: { id: recipient.id },
        data: { lastError: String(err.message || 'Send failed').slice(0, 500) },
      }).catch(() => {});
      return { sent: false, reason: 'send_error', email: recipient.email, error: err.message };
    }
    await hooks.recordBounce?.({
      campaignId: campaign.id,
      recipientId: recipient.id,
      stepId: step.id,
      error: err.message,
      senderId: senderUserId,
      senderAccountId: sender.id,
    });
    await checkCampaignBounceRate(campaign.id);
    await hooks.maybeCompleteCampaign?.(campaign.id, step.id);
    return { sent: false, reason: 'bounced', email: recipient.email, error: err.message };
  }
}

/**
 * Every sender that may send: connected Gmail accounts, plus the shared SendGrid row when
 * at least one workspace has SendGrid switched on and the key is set.
 */
export async function activeSenders() {
  const gmail = await prisma.gmailAccount.findMany({
    where: { refreshToken: { not: null }, sendingPausedAt: null },
  });
  const senders = gmail.filter((row) => !isSendGridAccount(row));
  if ((await sendGridWorkspaceIds()).length) {
    const sg = await findSendGridAccount();
    if (sg && !sg.sendingPausedAt) senders.push(sg);
  }
  return senders;
}

/**
 * One scheduler tick. Sends due emails for every connected sender, then waits for the
 * next due slot only if it fits inside budgetMs. Safe to call concurrently.
 */
export async function runSendTick({ budgetMs = 0, hooks } = {}) {
  const startedAt = Date.now();
  const results = [];

  await resumeQuotaPausedSenders();
  for (;;) {
    const senders = await activeSenders();
    let earliest = null;
    let anyWork = false;
    for (const sender of senders) {
      // Settings are read per email from the workspace being sent for.
      const result = await sendOneForSender(sender, null, { now: new Date(), hooks });
      results.push({ sender: sender.email, ...result });
      if (result.reason && result.reason !== 'gap' && result.reason !== 'bounced') {
        // idle, cap, paused, or stopped by the final check: nothing to wait for this tick.
        continue;
      }
      anyWork = true;
      const fresh = await prisma.gmailAccount.findUnique({ where: { id: sender.id }, select: { nextSendAt: true } });
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

/**
 * Per sender status for the UI, for one workspace: only the Gmail addresses linked in this
 * workspace. sentTodayHere counts this workspace's emails; sentToday is the address total
 * that the daily cap uses (it only differs when the same Gmail is linked in another
 * workspace too). Queued counts and pauses are this workspace's only.
 */
export async function sendingStatus(workspaceId) {
  await resumeQuotaPausedSenders();
  const ws = workspaceId ? await prisma.workspace.findUnique({ where: { id: workspaceId } }) : null;
  const settings = normalizeSendSettings(ws || {});
  const now = new Date();
  const links = ws
    ? await prisma.workspaceMember.findMany({
        where: { workspaceId: ws.id, gmailAccount: { refreshToken: { not: null } } },
        include: { gmailAccount: true, user: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'asc' },
      })
    : [];
  const rows = [];
  const seen = new Set();
  for (const link of links) {
    const sender = link.gmailAccount;
    if (seen.has(sender.id)) continue;
    seen.add(sender.id);
    const [sentToday, sentTodayHere, queued] = await Promise.all([
      sentTodayCount(sender, now),
      sentTodayCount(sender, now, { workspaceId: ws.id }),
      queuedCountForSender(sender, ws.id),
    ]);
    const capReached = sentToday >= settings.dailySendCap;
    const resumesAt = sentToday ? await capResumesAt(sender, settings.dailySendCap, now, { sentInWindow: sentToday }) : null;
    const hold = dailyLimitHold(sender, now);
    rows.push({
      accountId: sender.id,
      provider: 'gmail',
      userId: link.userId,
      email: sender.email,
      name: link.user?.name || '',
      sentToday,
      sentTodayHere,
      sharedWithOtherWorkspaces: sentToday !== sentTodayHere,
      queued,
      dailyCap: settings.dailySendCap,
      capReached,
      resumesAt: capReached ? resumesAt : null,
      // Gmail reported its own daily sending limit: held until this time, then resumes by itself.
      gmailLimitReached: Boolean(hold),
      gmailLimitUntil: hold ? hold.until : null,
      estimatedFinish: sender.sendingPausedAt
        ? null
        : estimateFinish({ now, queued, sentToday, nextSendAt: sender.nextSendAt, settings, capResumesAt: resumesAt }),
      emailsPerHour: emailsPerHour(settings),
      nextSendAt: sender.nextSendAt,
      inboxNotice: sender.inboxSyncNotice || '',
      inboxLastSyncAt: sender.lastInboxSyncAt,
      paused: Boolean(sender.sendingPausedAt),
      pausedAt: sender.sendingPausedAt,
      pausedReason: sender.sendingPausedReason,
    });
  }
  if (ws) {
    const sgRow = await sendGridStatusRow(ws, settings, now);
    if (sgRow) rows.push(sgRow);
  }
  const pausedCampaigns = ws
    ? await prisma.campaign.findMany({
        where: { pausedAt: { not: null }, workspaceId: ws.id },
        select: { id: true, name: true, pausedAt: true, pausedReason: true },
      })
    : [];
  return {
    settings,
    senders: rows,
    pausedCampaigns,
    globalPause: ws?.sendingPausedAt ? { pausedAt: ws.sendingPausedAt, reason: ws.sendingPausedReason } : null,
  };
}

/** The SendGrid line for the status panel, when SendGrid is switched on for this workspace. */
async function sendGridStatusRow(ws, settings, now) {
  const sg = await sendGridSettings(ws.id, { workspace: ws });
  if (!sg.enabled) return null;
  const sender = await findSendGridAccount();
  if (!sender) return null;
  const sgSettings = { ...settings, dailySendCap: sg.dailyCap };
  const [sentToday, sentTodayHere, queued] = await Promise.all([
    sentTodayCount(sender, now),
    sentTodayCount(sender, now, { workspaceId: ws.id }),
    queuedCountForSender(sender, ws.id),
  ]);
  const capReached = sentToday >= sg.dailyCap;
  const resumesAt = sentToday ? await capResumesAt(sender, sg.dailyCap, now, { sentInWindow: sentToday }) : null;
  const hold = dailyLimitHold(sender, now);
  return {
    accountId: sender.id,
    provider: 'sendgrid',
    userId: null,
    email: sg.fromEmail || 'SendGrid',
    name: sg.fromName,
    ready: sendGridReady(sg),
    keyConfigured: sg.keyConfigured,
    sentToday,
    sentTodayHere,
    sharedWithOtherWorkspaces: sentToday !== sentTodayHere,
    // Gmail and SendGrid work through the same queue, so this is the workspace's queue.
    queued,
    sharedQueue: true,
    dailyCap: sg.dailyCap,
    capReached,
    resumesAt: capReached ? resumesAt : null,
    gmailLimitReached: Boolean(hold),
    gmailLimitUntil: hold ? hold.until : null,
    estimatedFinish: sender.sendingPausedAt
      ? null
      : estimateFinish({ now, queued, sentToday, nextSendAt: sender.nextSendAt, settings: sgSettings, capResumesAt: resumesAt }),
    emailsPerHour: emailsPerHour(sgSettings),
    nextSendAt: sender.nextSendAt,
    inboxNotice: '',
    inboxLastSyncAt: null,
    paused: Boolean(sender.sendingPausedAt),
    pausedAt: sender.sendingPausedAt,
    pausedReason: sender.sendingPausedReason,
  };
}
