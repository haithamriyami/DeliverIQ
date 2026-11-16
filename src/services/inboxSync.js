/**
 * Throttled, incremental inbox sync (bounces + replies) per connected Gmail account.
 *
 * - At most once every INBOX_SYNC_EVERY_MS per account (manual "Check" at most once a minute).
 * - A per account lease (gmail_accounts.inbox_sync_lease_until) so overlapping runs never sync at once.
 * - Incremental: Gmail history API from the stored historyId, at most MAX_MESSAGES gets,
 *   only the fields we need.
 * - Gmail read quota errors back off the sync (exponential, Retry-After honored) and set a
 *   quiet notice. They NEVER pause sending.
 */
import { prisma } from '../lib/prisma.js';
import { fetchInboxDelta, bounceNoticesFromMessage, isReplyCandidate } from './gmailService.js';
import { applyBounceNotices, applyInboundReplies } from './campaignService.js';
import { isTransientQuotaError, retryAfterMs, backoffMs } from '../utils/sendErrors.js';

export const INBOX_SYNC_EVERY_MS = 5 * 60 * 1000;
export const MANUAL_SYNC_MIN_MS = 60 * 1000;
export const LEASE_MS = 2 * 60 * 1000;
export const MAX_MESSAGES = 40;

function fmtNairobi(date) {
  return new Date(date).toLocaleTimeString('en-GB', { timeZone: 'Africa/Nairobi', hour: '2-digit', minute: '2-digit' });
}

/** Claim the right to sync this account now. Atomic; false if throttled, backing off or leased. */
export async function claimInboxSync(accountId, { now = new Date(), force = false } = {}) {
  const minGap = force ? MANUAL_SYNC_MIN_MS : INBOX_SYNC_EVERY_MS;
  const result = await prisma.gmailAccount.updateMany({
    where: {
      id: accountId,
      refreshToken: { not: null },
      AND: [
        { OR: [{ inboxSyncLeaseUntil: null }, { inboxSyncLeaseUntil: { lt: now } }] },
        { OR: [{ inboxSyncNotBefore: null }, { inboxSyncNotBefore: { lte: now } }] },
        { OR: [{ lastInboxSyncAt: null }, { lastInboxSyncAt: { lte: new Date(now.getTime() - minGap) } }] },
      ],
    },
    data: { inboxSyncLeaseUntil: new Date(now.getTime() + LEASE_MS) },
  });
  return result.count === 1;
}

/** Record a failed sync: back off, quiet notice, never touch sending. */
export async function recordSyncFailure(account, err, now = new Date()) {
  const attempts = (account.inboxSyncErrors || 0) + 1;
  const quota = isTransientQuotaError(err);
  const wait = quota
    ? backoffMs(attempts, { baseMs: 60000, maxMs: 30 * 60000, retryAfter: retryAfterMs(err, now.getTime()) })
    : backoffMs(attempts, { baseMs: 5 * 60000, maxMs: 60 * 60000 });
  const notBefore = new Date(now.getTime() + wait);
  const notice = quota
    ? `Gmail asked DeliverIQ to read the inbox more slowly. Bounce and reply checks resume about ${fmtNairobi(notBefore)} Nairobi time. Sending is not affected.`
    : `Could not check the Gmail inbox (${String(err?.message || 'error').slice(0, 120)}). Trying again about ${fmtNairobi(notBefore)} Nairobi time. Sending is not affected.`;
  await prisma.gmailAccount.update({
    where: { id: account.id },
    data: { inboxSyncErrors: attempts, inboxSyncNotBefore: notBefore, inboxSyncNotice: notice, inboxSyncLeaseUntil: null },
  });
  return { notBefore, notice, quota };
}

/**
 * Sync one Gmail account (gmail_accounts row) if it is due. Dependencies are injectable for tests.
 */
export async function syncInboxForAccount(user, { now = new Date(), force = false, fetchDelta = fetchInboxDelta, applyBounces = applyBounceNotices, applyReplies = applyInboundReplies } = {}) {
  if (!(await claimInboxSync(user.id, { now, force }))) {
    return { skipped: true };
  }
  try {
    const delta = await fetchDelta(user.id, {
      historyId: user.gmailHistoryId,
      after: user.lastInboxSyncAt,
      max: MAX_MESSAGES,
    });
    const senderEmail = delta.senderEmail || String(user.email || '').toLowerCase();
    const notices = delta.messages.flatMap((m) => bounceNoticesFromMessage(m, senderEmail));
    const replies = delta.messages.filter((m) => isReplyCandidate(m, senderEmail));
    const bounceResult = notices.length ? await applyBounces(notices, user) : { marked: 0, emails: [] };
    const replyResult = replies.length ? await applyReplies(user, replies) : { scanned: 0, replies: 0, autoReplies: 0, optOuts: 0 };
    await prisma.gmailAccount.update({
      where: { id: user.id },
      data: {
        lastInboxSyncAt: now,
        gmailHistoryId: delta.historyId || user.gmailHistoryId,
        inboxSyncErrors: 0,
        inboxSyncNotBefore: null,
        inboxSyncNotice: '',
        inboxSyncLeaseUntil: null,
      },
    });
    return { skipped: false, scanned: delta.messages.length, bounces: bounceResult, replies: replyResult };
  } catch (err) {
    console.error(`[inbox] ${user.email}: ${err.message}`);
    const failure = await recordSyncFailure(user, err, now);
    return { skipped: false, error: err.message, ...failure };
  }
}

/** Old name, kept for callers and tests. */
export const syncInboxForUser = syncInboxForAccount;

/**
 * Sync every connected Gmail account. With workspaceId (a manual sync from the app), only
 * Gmail linked in that workspace is synced and counted.
 */
export async function syncAllInboxes({ force = false, now = new Date(), workspaceId, ...deps } = {}) {
  const users = await prisma.gmailAccount.findMany({
    where: {
      refreshToken: { not: null },
      ...(workspaceId ? { members: { some: { workspaceId } } } : {}),
    },
  });
  const out = {
    scanned: 0,
    bouncesMarked: 0,
    bouncedEmails: [],
    replies: { scanned: 0, replies: 0, autoReplies: 0, optOuts: 0 },
    skipped: true,
    notice: '',
  };
  for (const user of users) {
    const r = await syncInboxForAccount(user, { now, force, ...deps });
    if (r.skipped) continue;
    out.skipped = false;
    if (r.notice) out.notice = r.notice;
    out.scanned += r.scanned || 0;
    if (!workspaceId) {
      out.bouncesMarked += r.bounces?.marked || 0;
      out.bouncedEmails.push(...(r.bounces?.emails || []));
      for (const key of ['scanned', 'replies', 'autoReplies', 'optOuts']) out.replies[key] += r.replies?.[key] || 0;
      continue;
    }
    // A Gmail used by several workspaces finds bounces and replies for all of them. Only
    // report what belongs to the workspace that asked.
    const marks = r.bounces?.marks || (r.bounces?.emails || []).map((email) => ({ email, workspaceId }));
    const mine = marks.filter((mark) => mark.workspaceId === workspaceId).map((mark) => mark.email);
    out.bouncesMarked += mine.length;
    out.bouncedEmails.push(...mine);
    out.replies.scanned += r.replies?.scanned || 0;
    const here = r.replies?.byWorkspace ? r.replies.byWorkspace[workspaceId] || {} : r.replies || {};
    for (const key of ['replies', 'autoReplies', 'optOuts']) out.replies[key] += here[key] || 0;
  }
  return out;
}
