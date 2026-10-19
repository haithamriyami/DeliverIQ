import { prisma } from '../lib/prisma.js';
import { HttpError } from '../middleware/errorHandler.js';
import { campaignQueue, sendJobId } from '../queues/campaignQueue.js';
import { sendCampaignEmail, unsubscribeUrlFor } from './emailService.js';
import { env } from '../config/env.js';
import { listGmailBounceAddresses, listGmailInboundReplies } from './gmailService.js';
import { campaignAssignmentsForRecipients } from './recipientService.js';
import {
  runSendTick,
  checkCampaignBounceRate,
  resolveSenderUser,
  claimSendSlot,
  workspaceSendSettings,
  sentTodayCount,
} from './sendScheduler.js';
import { classifyReply } from '../utils/replyClassifier.js';
import { sendDecision } from '../utils/throttle.js';

function isSendable(recipient, step) {
  if (!recipient || recipient.status !== 'active' || recipient.doNotContact) return false;
  if (step && step.stepNumber > 1 && recipient.repliedAt) return false;
  return true;
}

/**
 * Run one throttled scheduler tick. budgetMs is how long this invocation may keep
 * waiting for the next send slot (0 means send only what is due right now).
 */
export async function runSchedulerTick({ budgetMs = 0 } = {}) {
  return runSendTick({
    budgetMs,
    hooks: { recordSend, recordBounce, maybeCompleteCampaign },
  });
}

function stepNameFor(stepNumber) {
  return stepNumber <= 1 ? 'Email 1' : `Follow-up ${stepNumber}`;
}

const campaignInclude = {
  template: true,
  createdBy: { select: { id: true, name: true, email: true } },
  list: { select: { id: true, name: true } },
  steps: {
    orderBy: { stepNumber: 'asc' },
    include: { template: true },
  },
};

function audienceIdsFor(campaign, step) {
  const ids = step?.recipientIds?.length ? step.recipientIds : campaign.recipientIds;
  return [...new Set(ids)];
}

async function ensureInitialStep(campaign) {
  if (campaign.steps?.length) {
    return campaign.steps[0];
  }

  const existing = await prisma.campaignStep.findFirst({
    where: { campaignId: campaign.id, stepNumber: 1 },
  });
  if (existing) {
    return existing;
  }

  return prisma.campaignStep.create({
    data: {
      campaignId: campaign.id,
      stepNumber: 1,
      name: 'Email 1',
      subject: campaign.subject,
      templateId: campaign.templateId,
      status: campaign.status,
      recipientIds: campaign.recipientIds,
    },
  });
}

async function resolveSendStep(campaign, stepId) {
  await ensureInitialStep(campaign);
  const steps = await prisma.campaignStep.findMany({
    where: { campaignId: campaign.id },
    orderBy: { stepNumber: 'asc' },
    include: { template: true },
  });
  campaign.steps = steps;

  if (stepId) {
    const match = steps.find((step) => step.id === stepId);
    if (!match) {
      throw new HttpError(404, 'Follow-up not found');
    }
    return match;
  }

  return steps[steps.length - 1];
}

export async function createCampaign({
  name,
  subject,
  templateId,
  scheduledAt,
  recipientIds,
  notes,
  listId,
  createdById,
}) {
  const template = await prisma.template.findUnique({
    where: { id: templateId },
  });

  if (!template) {
    throw new HttpError(404, 'Template not found');
  }

  const uniqueIds = [...new Set(recipientIds)];
  const recipients = await prisma.recipient.findMany({
    where: { id: { in: uniqueIds } },
    select: { id: true, listId: true, email: true, list: { select: { name: true } } },
  });

  if (recipients.length !== uniqueIds.length) {
    throw new HttpError(400, 'One or more recipient IDs are invalid');
  }

  if (listId) {
    const mixed = recipients.filter((row) => row.listId !== listId);
    if (mixed.length) {
      throw new HttpError(
        400,
        `Those contacts are not on this list: ${mixed.slice(0, 5).map((row) => row.email).join(', ')}`
      );
    }
  } else {
    const listIds = [...new Set(recipients.map((row) => row.listId))];
    if (listIds.length > 1) {
      throw new HttpError(400, 'Pick contacts from one list only, such as Agencies or Restaurants');
    }
    listId = listIds[0] || null;
  }

  const assignments = await campaignAssignmentsForRecipients(uniqueIds);
  const takenIds = uniqueIds.filter((id) => (assignments.get(id) || []).length > 0);
  if (takenIds.length) {
    const people = await prisma.recipient.findMany({
      where: { id: { in: takenIds } },
      select: { email: true, name: true, id: true },
    });
    const detail = people
      .slice(0, 8)
      .map((person) => {
        const names = (assignments.get(person.id) || []).map((campaign) => campaign.name).join(', ');
        return `${person.email} (${names})`;
      })
      .join('; ');
    const extra = people.length > 8 ? `; and ${people.length - 8} more` : '';
    throw new HttpError(
      400,
      `These people are already on another campaign: ${detail}${extra}`
    );
  }

  return prisma.campaign.create({
    data: {
      name,
      subject,
      templateId,
      scheduledAt: new Date(scheduledAt),
      recipientIds: uniqueIds,
      notes: notes || '',
      listId: listId || null,
      createdById: createdById || null,
      status: 'pending',
      steps: {
        create: {
          stepNumber: 1,
          name: 'Email 1',
          subject,
          templateId,
          status: 'pending',
          recipientIds: uniqueIds,
        },
      },
    },
    include: campaignInclude,
  });
}

export async function listCampaigns() {
  return prisma.campaign.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      template: { select: { id: true, name: true } },
      createdBy: { select: { id: true, name: true, email: true } },
      list: { select: { id: true, name: true } },
      steps: {
        orderBy: { stepNumber: 'asc' },
        include: { template: { select: { id: true, name: true } } },
      },
    },
  });
}

export async function getCampaignById(id) {
  const campaign = await prisma.campaign.findUnique({
    where: { id },
    include: campaignInclude,
  });

  if (!campaign) {
    throw new HttpError(404, 'Campaign not found');
  }

  await ensureInitialStep(campaign);
  return prisma.campaign.findUnique({
    where: { id },
    include: campaignInclude,
  });
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms))]);
}

/**
 * Delete a campaign. First stop it in the database (paused + every step closed) so any
 * sender tick that already picked one of its emails is refused by the final check right
 * before Gmail is called, then remove legacy queue jobs, then delete the rows.
 */
export async function deleteCampaign(id) {
  await getCampaignById(id);

  await prisma.$transaction([
    prisma.campaign.update({
      where: { id },
      data: { pausedAt: new Date(), pausedReason: 'Deleted', status: 'completed' },
    }),
    prisma.campaignStep.updateMany({ where: { campaignId: id }, data: { status: 'completed' } }),
  ]);

  const rows = await prisma.campaignRecipient.findMany({
    where: { campaignId: id },
    select: { recipientId: true },
  });
  const campaign = await prisma.campaign.findUnique({
    where: { id },
    select: { recipientIds: true, steps: { select: { id: true } } },
  });
  const recipientIds = new Set([...(campaign?.recipientIds || []), ...rows.map((row) => row.recipientId)]);
  const stepIds = (campaign?.steps || []).map((step) => step.id);

  // Legacy BullMQ jobs (only when Redis is configured). Never let Redis block the delete.
  await withTimeout(
    (async () => {
      for (const recipientId of recipientIds) {
        for (const jobId of [sendJobId(id, recipientId), ...stepIds.map((stepId) => sendJobId(id, recipientId, stepId))]) {
          try {
            const job = await campaignQueue.getJob(jobId);
            await job?.remove();
          } catch {
            // Job may already be gone.
          }
        }
      }
    })(),
    3000
  );

  await prisma.campaign.delete({ where: { id } });
  return { ok: true };
}

export async function enqueueCampaign(campaignId, stepId) {
  const campaign = await getCampaignById(campaignId);
  const step = await resolveSendStep(campaign, stepId);
  const audienceIds = audienceIdsFor(campaign, step);
  const template = step.template || campaign.template;

  const recipients = await prisma.recipient.findMany({
    where: { id: { in: audienceIds } },
  });

  const alreadyProcessed = await prisma.campaignRecipient.findMany({
    where: { stepId: step.id },
    select: { recipientId: true },
  });
  const alreadyProcessedIds = new Set(alreadyProcessed.map((row) => row.recipientId));

  const skipped = {
    alreadySent: 0,
    inactive: 0,
    missing: audienceIds.length - recipients.length,
  };

  const toSend = [];
  const skippedReplied = { count: 0 };

  for (const recipient of recipients) {
    if (alreadyProcessedIds.has(recipient.id)) {
      skipped.alreadySent += 1;
      continue;
    }

    if (!isSendable(recipient, step)) {
      if (recipient.status === 'active' && !recipient.doNotContact && recipient.repliedAt) {
        skippedReplied.count += 1;
      }
      skipped.inactive += 1;
      continue;
    }

    toSend.push(recipient);
  }
  skipped.replied = skippedReplied.count;

  if (toSend.length === 0) {
    const completed = await maybeCompleteCampaign(campaignId, step.id);
    return {
      campaign: completed || campaign,
      stepId: step.id,
      enqueued: 0,
      failed: 0,
      remaining: 0,
      queued: 0,
      skipped,
      errors: [],
    };
  }

  // Queue the step. The throttled scheduler (cron tick, or the open app) sends one
  // email per Gmail account at the configured gap (default 10 to 15 seconds), up to the daily cap.
  await prisma.$transaction([
    prisma.campaign.update({
      where: { id: campaignId },
      data: { status: 'sending' },
    }),
    prisma.campaignStep.update({
      where: { id: step.id },
      data: { status: 'sending' },
    }),
  ]);

  const tick = await runSchedulerTick({ budgetMs: 0 });
  const mine = tick.results.filter((row) => row.campaignId === campaignId || row.reason === 'sender_paused');
  const enqueued = mine.filter((row) => row.sent).length;
  const failed = mine.filter((row) => row.reason === 'bounced').length;
  const errors = mine
    .filter((row) => row.error)
    .map((row) => ({ email: row.email || row.sender, error: row.error }));

  await maybeCompleteCampaign(campaignId, step.id);
  const updated = await getCampaignById(campaignId);
  const remaining = await livePendingCount(updated, step);

  return {
    campaign: updated,
    stepId: step.id,
    enqueued,
    failed,
    remaining,
    queued: remaining,
    skipped,
    errors,
  };
}

export async function createFollowUp({ campaignId, subject, templateId, audience = 'active' }) {
  const campaign = await getCampaignById(campaignId);
  const template = await prisma.template.findUnique({ where: { id: templateId } });
  if (!template) {
    throw new HttpError(404, 'Template not found');
  }

  try {
    await syncBouncesFromGmail();
  } catch {
    // Gmail read may need reconnect; still allow creating the follow-up.
  }

  const last = campaign.steps[campaign.steps.length - 1];
  if (!last) {
    throw new HttpError(400, 'This campaign has no first email yet.');
  }
  const livePeople = await prisma.recipient.findMany({
    where: { id: { in: campaign.recipientIds } },
  });
  // People who replied (or opted out) never get another follow-up.
  const activePeople = livePeople.filter(
    (person) => person.status === 'active' && !person.doNotContact && !person.repliedAt
  );

  let recipientIds;
  if (audience === 'delivered') {
    const delivered = await prisma.campaignRecipient.findMany({
      where: {
        stepId: last.id,
        status: { in: ['sent', 'opened', 'clicked'] },
      },
      select: { recipientId: true },
    });
    const deliveredIds = new Set(delivered.map((row) => row.recipientId));
    recipientIds = activePeople.filter((person) => deliveredIds.has(person.id)).map((person) => person.id);
  } else {
    recipientIds = activePeople.map((person) => person.id);
  }

  if (recipientIds.length === 0) {
    throw new HttpError(
      400,
      'Nobody left for this follow-up. Bounced, replied, opted out, and removed contacts are skipped.'
    );
  }

  const stepNumber = last.stepNumber + 1;
  // A new follow-up supersedes earlier steps; nobody still waiting gets the older email later.
  await prisma.campaignStep.updateMany({
    where: { campaignId: campaign.id, status: 'sending' },
    data: { status: 'completed' },
  });
  const step = await prisma.campaignStep.create({
    data: {
      campaignId: campaign.id,
      stepNumber,
      name: stepNameFor(stepNumber),
      subject,
      templateId,
      status: 'pending',
      recipientIds,
    },
    include: { template: true },
  });

  await prisma.campaign.update({
    where: { id: campaign.id },
    data: {
      subject,
      templateId,
      status: 'pending',
    },
  });

  return getCampaignById(campaign.id).then((updated) => ({ campaign: updated, step }));
}

export async function maybeCompleteCampaign(campaignId, stepId) {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: { steps: { orderBy: { stepNumber: 'asc' } } },
  });

  if (!campaign) {
    return campaign;
  }

  const steps = campaign.steps.length ? campaign.steps : [await ensureInitialStep(campaign)];
  const targetSteps = stepId ? steps.filter((step) => step.id === stepId) : steps;

  for (const step of targetSteps) {
    const pending = await livePendingCount(campaign, step);
    if (pending === 0 && step.status !== 'completed') {
      await prisma.campaignStep.update({
        where: { id: step.id },
        data: { status: 'completed' },
      });
      step.status = 'completed';
    }
  }

  const refreshed = await prisma.campaignStep.findMany({
    where: { campaignId },
    orderBy: { stepNumber: 'asc' },
  });
  const latest = refreshed[refreshed.length - 1];
  const nextStatus = latest?.status || campaign.status;

  if (campaign.status !== nextStatus) {
    return prisma.campaign.update({
      where: { id: campaignId },
      data: { status: nextStatus },
      include: campaignInclude,
    });
  }

  return prisma.campaign.findUnique({
    where: { id: campaignId },
    include: campaignInclude,
  });
}

export async function getCampaignReport(campaignId) {
  const campaign = await getCampaignById(campaignId);

  const grouped = await prisma.campaignRecipient.groupBy({
    by: ['status'],
    where: { campaignId },
    _count: { _all: true },
  });

  const counts = { sent: 0, bounced: 0, opened: 0, clicked: 0 };
  for (const row of grouped) {
    counts[row.status] = row._count._all;
  }

  const delivered = counts.sent + counts.opened + counts.clicked;
  const currentStep = await resolveSendStep(campaign);
  const livePending = await livePendingCount(campaign, currentStep);
  const funnel = funnelFromCounts(counts, {
    audienceSize: audienceIdsFor(campaign, currentStep).length,
    pending: livePending,
  });
  const opened = counts.opened + counts.clicked;

  return {
    campaignId: campaign.id,
    name: campaign.name,
    subject: campaign.subject,
    status: campaign.status,
    scheduledAt: campaign.scheduledAt,
    audienceSize: campaign.recipientIds.length,
    totals: {
      sent: delivered,
      bounced: counts.bounced,
      opened,
      clicked: counts.clicked,
      pending: funnel.pending,
    },
    rates: {
      bounceRate: funnel.bounceRate,
      openRate: funnel.openRate,
      clickRate: funnel.clickRate,
    },
  };
}

const STATUS_RANK = {
  sent: 1,
  opened: 2,
  clicked: 3,
  bounced: 4,
};

export async function recordSend({ campaignId, recipientId, stepId, messageId, threadId, senderId }) {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: { steps: { orderBy: { stepNumber: 'asc' } } },
  });
  const step = stepId
    ? campaign?.steps.find((item) => item.id === stepId)
    : campaign?.steps[campaign.steps.length - 1];
  if (!step) {
    throw new HttpError(404, 'Follow-up not found');
  }

  const existing = await prisma.campaignRecipient.findUnique({
    where: {
      stepId_recipientId: { stepId: step.id, recipientId },
    },
  });

  if (!existing) {
    return prisma.campaignRecipient.create({
      data: {
        campaignId,
        stepId: step.id,
        recipientId,
        status: 'sent',
        sentAt: new Date(),
        messageId: messageId || null,
        threadId: threadId || null,
        senderId: senderId || null,
      },
    });
  }

  const keepStatus =
    STATUS_RANK[existing.status] >= STATUS_RANK.sent ? existing.status : 'sent';

  return prisma.campaignRecipient.update({
    where: { id: existing.id },
    data: {
      sentAt: existing.sentAt || new Date(),
      status: keepStatus,
      messageId: messageId || existing.messageId,
      threadId: threadId || existing.threadId,
      senderId: senderId || existing.senderId,
    },
  });
}

export async function recordBounce({ campaignId, recipientId, error, stepId, senderId }) {
  const reason = String(error || 'Bounced').slice(0, 500);

  await prisma.recipient.update({
    where: { id: recipientId },
    data: { status: 'bounced', lastError: reason },
  });

  const rows = await prisma.campaignRecipient.findMany({
    where: {
      recipientId,
      ...(campaignId ? { campaignId } : {}),
      ...(stepId ? { stepId } : {}),
    },
    orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
  });

  if (rows.length === 0 && campaignId) {
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      include: { steps: { orderBy: { stepNumber: 'asc' } } },
    });
    const step = stepId
      ? campaign?.steps.find((item) => item.id === stepId)
      : campaign?.steps[campaign.steps.length - 1];
    if (step) {
      return prisma.campaignRecipient.create({
        data: {
          campaignId,
          stepId: step.id,
          recipientId,
          status: 'bounced',
          error: reason,
          sentAt: new Date(),
          senderId: senderId || null,
        },
      });
    }
  }

  // Live send failures pass stepId — mark that attempt only.
  // Inbox sync without a step must not rewrite opened/clicked history, and must not
  // flip every past email for the same person into a bounce (that inflated dashboard totals).
  const targets = stepId
    ? rows
    : rows.filter((row) => row.status === 'sent' || row.status === 'bounced').slice(0, 1);

  let last = null;
  for (const row of targets) {
    last = await prisma.campaignRecipient.update({
      where: { id: row.id },
      data: {
        status: 'bounced',
        error: reason,
      },
    });
  }
  return last;
}

export async function listCampaignAudience(campaignId, kind = 'sent', stepId) {
  const campaign = await getCampaignById(campaignId);
  const step = await resolveSendStep(campaign, stepId);
  const audienceIds = audienceIdsFor(campaign, step);

  if (kind === 'pending') {
    const processed = await prisma.campaignRecipient.findMany({
      where: { stepId: step.id },
      select: { recipientId: true },
    });
    const processedIds = new Set(processed.map((row) => row.recipientId));
    const people = await prisma.recipient.findMany({
      where: {
        id: { in: audienceIds },
        status: 'active',
      },
      orderBy: { email: 'asc' },
    });
    return people
      .filter((person) => !processedIds.has(person.id) && isSendable(person, step))
      .map((person) => ({
        status: 'pending',
        error: 'Queued',
        recipient: {
          id: person.id,
          email: person.email,
          name: person.name,
          status: person.status,
          lastError: person.lastError,
        },
      }));
  }

  const where =
    kind === 'bounced'
      ? { stepId: step.id, status: 'bounced' }
      : { stepId: step.id, status: { in: ['sent', 'opened', 'clicked'] } };

  return prisma.campaignRecipient.findMany({
    where,
    include: {
      recipient: {
        select: { id: true, email: true, name: true, status: true, lastError: true },
      },
    },
    orderBy: { sentAt: 'desc' },
  });
}

export async function listCampaignBounces(campaignId) {
  return listCampaignAudience(campaignId, 'bounced');
}

export async function syncBouncesFromGmail() {
  const notices = await listGmailBounceAddresses();
  if (notices.length === 0) {
    return { scanned: 0, marked: 0, emails: [] };
  }

  const byEmail = new Map(notices.map((row) => [row.email, row.reason]));
  const recipients = await prisma.recipient.findMany({
    where: { email: { in: [...byEmail.keys()] } },
  });

  const emails = [];
  const touchedCampaigns = new Set();
  for (const recipient of recipients) {
    const reason =
      byEmail.get(recipient.email) ||
      recipient.lastError ||
      'Gmail reported this address as undeliverable or delayed.';

    await prisma.recipient.update({
      where: { id: recipient.id },
      data: {
        status: 'bounced',
        lastError: reason,
      },
    });

    // Only mark the latest uncertain send as bounced — not every past follow-up row.
    const latestSent = await prisma.campaignRecipient.findFirst({
      where: { recipientId: recipient.id, status: 'sent' },
      orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
    });

    if (latestSent) {
      await recordBounce({
        campaignId: latestSent.campaignId,
        recipientId: recipient.id,
        stepId: latestSent.stepId,
        error: reason,
      });
    }

    emails.push(recipient.email);
    if (latestSent) touchedCampaigns.add(latestSent.campaignId);
  }

  for (const campaignId of touchedCampaigns) {
    await checkCampaignBounceRate(campaignId);
  }

  return { scanned: notices.length, marked: emails.length, emails };
}

export async function applyEngagementEvent({ campaignId, recipientId, event, stepId }) {
  const statusMap = {
    bounce: 'bounced',
    dropped: 'bounced',
    open: 'opened',
    click: 'clicked',
  };

  const nextStatus = statusMap[event];
  if (!nextStatus || !campaignId || !recipientId) {
    return null;
  }

  const existing = stepId
    ? await prisma.campaignRecipient.findUnique({
        where: { stepId_recipientId: { stepId, recipientId } },
      })
    : await prisma.campaignRecipient.findFirst({
        where: { campaignId, recipientId },
        orderBy: { sentAt: 'desc' },
      });

  if (!existing) {
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      include: { steps: { orderBy: { stepNumber: 'asc' } } },
    });
    const step = stepId
      ? campaign?.steps.find((item) => item.id === stepId)
      : campaign?.steps[campaign.steps.length - 1];
    if (!step) {
      return null;
    }
    return prisma.campaignRecipient.create({
      data: {
        campaignId,
        stepId: step.id,
        recipientId,
        status: nextStatus,
        sentAt: nextStatus === 'sent' ? new Date() : undefined,
      },
    });
  }

  if (STATUS_RANK[nextStatus] < STATUS_RANK[existing.status]) {
    return existing;
  }

  return prisma.campaignRecipient.update({
    where: { id: existing.id },
    data: { status: nextStatus },
  });
}

function emptyCounts() {
  return { sent: 0, bounced: 0, opened: 0, clicked: 0 };
}

function funnelFromCounts(counts, { audienceSize = 0, pending = 0 } = {}) {
  const delivered = counts.sent + counts.opened + counts.clicked;
  const attempted = delivered + counts.bounced;
  const opened = counts.opened + counts.clicked;
  return {
    sent: delivered,
    bounced: counts.bounced,
    opened,
    clicked: counts.clicked,
    pending: pending || Math.max(0, audienceSize - attempted),
    attempted,
    bounceRate: attempted ? counts.bounced / attempted : 0,
    openRate: delivered ? opened / delivered : 0,
    clickRate: delivered ? counts.clicked / delivered : 0,
  };
}

/**
 * Idempotent repair of step and campaign status. Counts are always computed live from
 * campaign_recipients, so only statuses can drift:
 * - an older step still in "sending" after a newer step exists is superseded: mark it completed
 *   (the scheduler never sends it, see queuedSteps)
 * Returns the step ids it changed. With apply=false it only reports.
 */
export const FALSE_BOUNCE_ERRORS = ['Follow-up not found', 'Campaign not found'];

export async function reconcileCampaignSteps({ apply = true } = {}) {
  // Contacts wrongly marked bounced when a send succeeded but its campaign had just been
  // deleted (the old code treated the "not found" while recording as a bounce).
  const falseBounces = await prisma.recipient.findMany({
    where: { status: 'bounced', lastError: { in: FALSE_BOUNCE_ERRORS } },
    select: { id: true },
  });
  if (apply && falseBounces.length) {
    await prisma.recipient.updateMany({
      where: { id: { in: falseBounces.map((row) => row.id) }, status: 'bounced', lastError: { in: FALSE_BOUNCE_ERRORS } },
      data: { status: 'active', lastError: '' },
    });
  }

  const stale = await prisma.campaignStep.findMany({
    where: { status: 'sending' },
    select: {
      id: true,
      stepNumber: true,
      campaignId: true,
      campaign: { select: { name: true, steps: { select: { stepNumber: true }, orderBy: { stepNumber: 'desc' }, take: 1 } } },
    },
  });
  const superseded = stale.filter((step) => step.stepNumber < (step.campaign.steps[0]?.stepNumber ?? step.stepNumber));
  if (apply && superseded.length) {
    await prisma.campaignStep.updateMany({
      where: { id: { in: superseded.map((step) => step.id) }, status: 'sending' },
      data: { status: 'completed' },
    });
  }
  return superseded.map((step) => ({ stepId: step.id, campaignId: step.campaignId, campaign: step.campaign.name, stepNumber: step.stepNumber }));
}

export async function listCampaignsWithStats() {
  await reconcileCampaignSteps();
  const campaigns = await listCampaigns();
  if (campaigns.length === 0) {
    return [];
  }

  const campaignIds = campaigns.map((campaign) => campaign.id);
  const allAudienceIds = [...new Set(campaigns.flatMap((campaign) => [
    ...campaign.recipientIds,
    ...campaign.steps.flatMap((step) => step.recipientIds),
  ]))];
  const [grouped, rows, people, replyGroups] = await Promise.all([
    prisma.campaignRecipient.groupBy({
      by: ['stepId', 'status'],
      _count: { _all: true },
    }),
    prisma.campaignRecipient.findMany({
      where: { campaignId: { in: campaignIds } },
      select: { campaignId: true, stepId: true, recipientId: true },
    }),
    prisma.recipient.findMany({
      where: { id: { in: allAudienceIds } },
      select: { id: true, status: true, doNotContact: true, repliedAt: true },
    }),
    prisma.inboundReply.groupBy({
      by: ['campaignId', 'type'],
      where: { campaignId: { in: campaignIds } },
      _count: { _all: true },
    }),
  ]);

  const repliesByCampaign = new Map();
  for (const row of replyGroups) {
    if (!repliesByCampaign.has(row.campaignId)) {
      repliesByCampaign.set(row.campaignId, { replies: 0, autoReplies: 0, optOuts: 0 });
    }
    const bucket = repliesByCampaign.get(row.campaignId);
    if (row.type === 'reply') bucket.replies += row._count._all;
    if (row.type === 'auto_reply') bucket.autoReplies += row._count._all;
    if (row.type === 'opt_out') bucket.optOuts += row._count._all;
  }

  const byStep = new Map();
  for (const row of grouped) {
    if (!byStep.has(row.stepId)) {
      byStep.set(row.stepId, emptyCounts());
    }
    byStep.get(row.stepId)[row.status] = row._count._all;
  }

  const processedByStep = new Map();
  for (const row of rows) {
    if (!processedByStep.has(row.stepId)) {
      processedByStep.set(row.stepId, new Set());
    }
    processedByStep.get(row.stepId).add(row.recipientId);
  }

  const peopleById = new Map(people.map((person) => [person.id, person]));

  const reconciled = await Promise.all(
    campaigns.map(async (campaign) => {
      if (!campaign.steps.length) {
        await ensureInitialStep(campaign);
        campaign.steps = await prisma.campaignStep.findMany({
          where: { campaignId: campaign.id },
          orderBy: { stepNumber: 'asc' },
        });
      }

      const liveIds = campaign.recipientIds.filter((id) => peopleById.has(id));
      if (liveIds.length !== campaign.recipientIds.length) {
        await prisma.campaign.update({
          where: { id: campaign.id },
          data: { recipientIds: liveIds },
        });
        campaign.recipientIds = liveIds;
      }

      const stepSummaries = [];
      for (const step of campaign.steps) {
        const audience = audienceIdsFor(campaign, step).filter((id) => peopleById.has(id));
        const processed = processedByStep.get(step.id) || new Set();
        const pending = audience.filter((id) => {
          const person = peopleById.get(id);
          return isSendable(person, step) && !processed.has(id);
        }).length;

        if (pending === 0 && step.status === 'sending') {
          await prisma.campaignStep.update({
            where: { id: step.id },
            data: { status: 'completed' },
          });
          step.status = 'completed';
        }

        const totals = funnelFromCounts(byStep.get(step.id) || emptyCounts(), {
          audienceSize: audience.length,
          pending,
        });
        stepSummaries.push({
          id: step.id,
          name: step.name,
          stepNumber: step.stepNumber,
          subject: step.subject,
          status: step.status,
          totals: {
            sent: totals.sent,
            bounced: totals.bounced,
            opened: totals.opened,
            clicked: totals.clicked,
            pending: totals.pending,
          },
        });
      }

      const currentStep = stepSummaries[stepSummaries.length - 1];
      const allSteps = stepSummaries.reduce(
        (sum, step) => ({
          sent: sum.sent + step.totals.sent,
          bounced: sum.bounced + step.totals.bounced,
          opened: sum.opened + step.totals.opened,
          clicked: sum.clicked + step.totals.clicked,
        }),
        { sent: 0, bounced: 0, opened: 0, clicked: 0 }
      );
      if (currentStep && campaign.status !== currentStep.status) {
        await prisma.campaign.update({
          where: { id: campaign.id },
          data: { status: currentStep.status },
        });
        campaign.status = currentStep.status;
      }

      return {
        ...campaign,
        paused: Boolean(campaign.pausedAt),
        allSteps,
        replyStats: repliesByCampaign.get(campaign.id) || { replies: 0, autoReplies: 0, optOuts: 0 },
        currentStep,
        steps: stepSummaries,
        totals: currentStep?.totals || {
          sent: 0,
          bounced: 0,
          opened: 0,
          clicked: 0,
          pending: 0,
        },
        rates: funnelFromCounts(byStep.get(currentStep?.id) || emptyCounts(), {
          audienceSize: audienceIdsFor(campaign, campaign.steps[campaign.steps.length - 1]).length,
          pending: currentStep?.totals.pending || 0,
        }),
      };
    })
  );

  return reconciled;
}

async function livePendingCount(campaign, step) {
  const audienceIds = audienceIdsFor(campaign, step);
  const [existing, processed] = await Promise.all([
    prisma.recipient.findMany({
      where: { id: { in: audienceIds } },
      select: { id: true, status: true, doNotContact: true, repliedAt: true },
    }),
    prisma.campaignRecipient.findMany({
      where: { stepId: step.id },
      select: { recipientId: true },
    }),
  ]);
  const processedIds = new Set(processed.map((row) => row.recipientId));
  return existing.filter((row) => isSendable(row, step) && !processedIds.has(row.id)).length;
}

export async function getDashboard() {
  const [campaigns, recipients, grouped, attemptedPeople] = await Promise.all([
    listCampaignsWithStats(),
    prisma.recipient.findMany({ select: { id: true, status: true } }),
    prisma.campaignRecipient.groupBy({
      by: ['status'],
      _count: { _all: true },
    }),
    prisma.campaignRecipient.findMany({
      select: { recipientId: true },
      distinct: ['recipientId'],
    }),
  ]);

  const counts = emptyCounts();
  for (const row of grouped) {
    counts[row.status] = row._count._all;
  }
  const funnel = funnelFromCounts(counts);

  // Unique people, not bounce rows across every follow-up (that was inflating 186 → 229).
  const bouncedRecipients = recipients.filter((r) => r.status === 'bounced').length;
  const unsubscribedRecipients = recipients.filter((r) => r.status === 'unsubscribed').length;
  const attemptedUnique = attemptedPeople.length;
  const bounceRate = attemptedUnique ? bouncedRecipients / attemptedUnique : 0;

  const upcoming = campaigns
    .filter((c) => c.status === 'pending' || c.status === 'sending')
    .slice(0, 5);

  const chart = campaigns
    .slice()
    .reverse()
    .slice(-7)
    .map((c) => ({
      label: c.name,
      opens: c.totals.opened,
      clicks: c.totals.clicked,
    }));

  return {
    kpis: {
      totalCampaigns: campaigns.length,
      emailsSent: funnel.sent,
      openRate: funnel.openRate,
      bounceRate,
      bounced: bouncedRecipients,
      pending: campaigns.reduce((sum, c) => sum + (c.totals?.pending || 0), 0),
    },
    recent: campaigns.slice(0, 8),
    upcoming,
    chart,
    bounceUnsub: {
      bounces: bouncedRecipients,
      unsubscribes: unsubscribedRecipients,
    },
  };
}

export async function sendTestEmail({ campaignId, to }) {
  const campaign = await getCampaignById(campaignId);
  if (!to) {
    throw new HttpError(400, 'Test email address is required');
  }

  const step = await resolveSendStep(campaign);
  const template = step.template || campaign.template;

  // Test sends use the same Gmail account, so they respect the same gap and daily cap.
  const sender = await resolveSenderUser(campaign.createdById);
  if (sender) {
    const settings = await workspaceSendSettings();
    const decision = sendDecision({
      now: new Date(),
      nextSendAt: sender.nextSendAt,
      sentToday: await sentTodayCount(sender.id),
      settings,
      pausedAt: sender.sendingPausedAt,
    });
    if (!decision.ok || !(await claimSendSlot(sender.id, settings))) {
      const why = decision.reason === 'paused'
        ? 'Sending from this Gmail account is paused. Resume it first.'
        : decision.reason === 'daily_cap'
          ? 'The daily limit for this Gmail account is reached. Try again tomorrow.'
          : 'This Gmail account sent an email a few seconds ago. Try the test again in a moment.';
      throw new HttpError(429, why);
    }
  }

  return sendCampaignEmail({
    to,
    name: 'there',
    subject: `[Test] ${step.subject}`,
    html: template.body,
    campaignId: campaign.id,
    recipientId: 'test',
    stepId: step.id,
    unsubscribeUrl: `${env.appUrl}/unsubscribe.html`,
    userId: sender?.id || campaign.createdById,
  });
}

/**
 * Read recent inbox messages for every connected Gmail account, match them to campaign
 * sends (thread id first, then sender address), classify, and store them.
 * Human replies stop follow-ups; opt outs also mark the contact do not contact;
 * auto replies are only counted.
 */
export async function syncRepliesFromGmail({ classify = classifyReply } = {}) {
  const senders = await prisma.user.findMany({ where: { gmailRefreshToken: { not: null } } });
  const summary = { scanned: 0, replies: 0, autoReplies: 0, optOuts: 0 };

  for (const sender of senders) {
    let messages;
    try {
      messages = await listGmailInboundReplies(sender.id);
    } catch (err) {
      console.error(`[replies] ${sender.gmailEmail}: ${err.message}`);
      continue;
    }
    await prisma.user.update({ where: { id: sender.id }, data: { lastInboxSyncAt: new Date() } });

    for (const message of messages) {
      summary.scanned += 1;
      const seen = await prisma.inboundReply.findUnique({ where: { gmailMessageId: message.id } });
      if (seen) continue;

      let send = message.threadId
        ? await prisma.campaignRecipient.findFirst({
            where: { threadId: message.threadId },
            orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
            include: { recipient: true },
          })
        : null;
      if (!send && message.fromEmail) {
        send = await prisma.campaignRecipient.findFirst({
          where: { recipient: { email: message.fromEmail } },
          orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
          include: { recipient: true },
        });
      }
      if (!send) continue;
      // Ignore anything older than our first email to this person in this thread.
      if (send.sentAt && message.receivedAt && message.receivedAt < send.sentAt) continue;

      const type = classify({ subject: message.subject, body: message.body, headers: message.headers });
      await prisma.inboundReply.create({
        data: {
          gmailMessageId: message.id,
          threadId: message.threadId || null,
          type,
          senderId: sender.id,
          recipientId: send.recipientId,
          campaignId: send.campaignId,
          subject: String(message.subject || '').slice(0, 300),
          snippet: String(message.snippet || '').slice(0, 500),
          receivedAt: message.receivedAt || new Date(),
        },
      });

      if (type === 'auto_reply') {
        summary.autoReplies += 1;
        continue;
      }

      const data = { repliedAt: send.recipient.repliedAt || message.receivedAt || new Date() };
      if (type === 'opt_out') {
        summary.optOuts += 1;
        Object.assign(data, {
          doNotContact: true,
          status: send.recipient.status === 'bounced' ? 'bounced' : 'unsubscribed',
          lastError: 'Asked not to be contacted (reply)',
        });
      } else {
        summary.replies += 1;
      }
      await prisma.recipient.update({ where: { id: send.recipientId }, data });
    }
  }

  return summary;
}
