/**
 * Throttled, incremental inbox sync (bounces + replies) per connected Gmail account.
 *
 * - At most once every INBOX_SYNC_EVERY_MS per account (manual "Check" at most once a minute).
 * - A per account lease (users.inbox_sync_lease_until) so overlapping runs never sync at once.
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
export async function claimInboxSync(userId, { now = new Date(), force = false } = {}) {
  const minGap = force ? MANUAL_SYNC_MIN_MS : INBOX_SYNC_EVERY_MS;
  const result = await prisma.user.updateMany({
    where: {
      id: userId,
      gmailRefreshToken: { not: null },
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
export async function recordSyncFailure(user, err, now = new Date()) {
  const attempts = (user.inboxSyncErrors || 0) + 1;
  const quota = isTransientQuotaError(err);
  const wait = quota
    ? backoffMs(attempts, { baseMs: 60000, maxMs: 30 * 60000, retryAfter: retryAfterMs(err, now.getTime()) })
    : backoffMs(attempts, { baseMs: 5 * 60000, maxMs: 60 * 60000 });
  const notBefore = new Date(now.getTime() + wait);
  const notice = quota
    ? `Gmail asked DeliverIQ to read the inbox more slowly. Bounce and reply checks resume about ${fmtNairobi(notBefore)} Nairobi time. Sending is not affected.`
    : `Could not check the Gmail inbox (${String(err?.message || 'error').slice(0, 120)}). Trying again about ${fmtNairobi(notBefore)} Nairobi time. Sending is not affected.`;
  await prisma.user.update({
    where: { id: user.id },
    data: { inboxSyncErrors: attempts, inboxSyncNotBefore: notBefore, inboxSyncNotice: notice, inboxSyncLeaseUntil: null },
  });
  return { notBefore, notice, quota };
}

/**
 * Sync one account if it is due. Dependencies are injectable for tests.
 */
export async function syncInboxForUser(user, { now = new Date(), force = false, fetchDelta = fetchInboxDelta, applyBounces = applyBounceNotices, applyReplies = applyInboundReplies } = {}) {
  if (!(await claimInboxSync(user.id, { now, force }))) {
    return { skipped: true };
  }
  try {
    const delta = await fetchDelta(user.id, {
      historyId: user.gmailHistoryId,
      after: user.lastInboxSyncAt,
      max: MAX_MESSAGES,
    });
    const senderEmail = delta.senderEmail || String(user.gmailEmail || '').toLowerCase();
    const notices = delta.messages.flatMap((m) => bounceNoticesFromMessage(m, senderEmail));
    const replies = delta.messages.filter((m) => isReplyCandidate(m, senderEmail));
    const bounceResult = notices.length ? await applyBounces(notices) : { marked: 0, emails: [] };
    const replyResult = replies.length ? await applyReplies(user, replies) : { scanned: 0, replies: 0, autoReplies: 0, optOuts: 0 };
    await prisma.user.update({
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
    console.error(`[inbox] ${user.gmailEmail}: ${err.message}`);
    const failure = await recordSyncFailure(user, err, now);
    return { skipped: false, error: err.message, ...failure };
  }
}

export async function syncAllInboxes({ force = false, now = new Date(), ...deps } = {}) {
  const users = await prisma.user.findMany({ where: { gmailRefreshToken: { not: null } } });
  const out = {
    scanned: 0,
    bouncesMarked: 0,
    bouncedEmails: [],
    replies: { scanned: 0, replies: 0, autoReplies: 0, optOuts: 0 },
    skipped: true,
    notice: '',
  };
  for (const user of users) {
    const r = await syncInboxForUser(user, { now, force, ...deps });
    if (r.skipped) continue;
    out.skipped = false;
    if (r.notice) out.notice = r.notice;
    out.scanned += r.scanned || 0;
    out.bouncesMarked += r.bounces?.marked || 0;
    out.bouncedEmails.push(...(r.bounces?.emails || []));
    for (const key of ['scanned', 'replies', 'autoReplies', 'optOuts']) out.replies[key] += r.replies?.[key] || 0;
  }
  return out;
}
