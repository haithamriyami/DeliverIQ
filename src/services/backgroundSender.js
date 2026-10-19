/**
 * Long running background sender for Vercel.
 *
 * One run keeps sending (gap, cap and every last-second check still apply per email)
 * until close to the function deadline, then, if it actually sent something and work is
 * still sendable, starts the next run by calling /cron/send-tick on itself. A lease row
 * makes sure only one run is active; a second trigger (cron, Send button, open tab,
 * external pinger) just returns. Even if two runs overlap, the atomic per account slot
 * claim in users.next_send_at prevents double sending.
 */
import crypto from 'crypto';
import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import { runSchedulerTick } from './campaignService.js';
import { globalPauseFor, workspaceSendSettings, sentTodayCount, nextPendingForSender } from './sendScheduler.js';
import { normalizeSendSettings } from '../utils/throttle.js';

export const LEASE_NAME = 'sender';

export async function acquireLease(holder, ms, now = new Date()) {
  const expiresAt = new Date(now.getTime() + ms);
  try {
    await prisma.schedulerLease.create({ data: { name: LEASE_NAME, holder, expiresAt } });
    return true;
  } catch {
    // Row exists: take it only if the previous run's lease has expired.
  }
  const result = await prisma.schedulerLease.updateMany({
    where: { name: LEASE_NAME, expiresAt: { lt: now } },
    data: { holder, expiresAt },
  });
  return result.count === 1;
}

export async function releaseLease(holder) {
  await prisma.schedulerLease.updateMany({
    where: { name: LEASE_NAME, holder },
    data: { expiresAt: new Date() },
  });
}

/** Is there anything that could be sent right now or within this run? */
export async function hasSendableWork() {
  if (await globalPauseFor()) return false;
  const settings = normalizeSendSettings(await workspaceSendSettings());
  const senders = await prisma.user.findMany({ where: { gmailRefreshToken: { not: null }, sendingPausedAt: null } });
  for (const sender of senders) {
    if ((await sentTodayCount(sender.id)) >= settings.dailySendCap) continue;
    if (await nextPendingForSender(sender)) return true;
  }
  return false;
}

function selfChainEnabled() {
  return Boolean(process.env.VERCEL) && Boolean(env.cronSecret) && process.env.SEND_SELF_CHAIN !== 'false';
}

/** Start the next run in a fresh invocation. Fire and forget. */
export async function triggerNextRun(fetchImpl = fetch) {
  if (!selfChainEnabled()) return false;
  try {
    await fetchImpl(`${env.appUrl}/cron/send-tick?chain=1`, {
      headers: { Authorization: `Bearer ${env.cronSecret}` },
      signal: AbortSignal.timeout(8000),
    });
    return true;
  } catch (err) {
    console.error('[sender] could not start next run:', err.message);
    return false;
  }
}

/**
 * One background run. Returns quickly with { skipped: 'already_running' } if another
 * run holds the lease.
 */
export async function runBackgroundSender({ budgetMs, beforeRun, chain = true, trigger = triggerNextRun } = {}) {
  const holder = crypto.randomUUID();
  const budgetOf = () => (typeof budgetMs === 'function' ? budgetMs() : budgetMs);
  if (!(await acquireLease(holder, budgetOf() + 30000))) {
    return { skipped: 'already_running' };
  }
  let tick;
  let extra;
  try {
    extra = beforeRun ? await beforeRun() : undefined;
    // Budget is measured after the inbox sync so the run still ends before the deadline.
    tick = await runSchedulerTick({ budgetMs: budgetOf() });
  } finally {
    await releaseLease(holder);
  }
  const sent = tick.results.filter((row) => row.sent).length;
  let chained = false;
  // Only chain after a productive run so a stuck state can never loop invocations.
  if (chain && sent > 0 && (await hasSendableWork())) {
    chained = await trigger();
  }
  return { sent, ranMs: tick.ranMs, chained, extra };
}
