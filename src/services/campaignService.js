import { prisma } from '../lib/prisma.js';
import { HttpError } from '../middleware/errorHandler.js';
import { campaignQueue, sendJobId } from '../queues/campaignQueue.js';
import { sendCampaignEmail, unsubscribeUrlFor } from './emailService.js';
import { env } from '../config/env.js';
import { listGmailBounceAddresses } from './gmailService.js';

const SEND_BATCH_SIZE = 8;
const SEND_GAP_MS = 1500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stepNameFor(stepNumber) {
  return stepNumber <= 1 ? 'Email 1' : `Follow-up ${stepNumber}`;
}

const campaignInclude = {
  template: true,
  createdBy: { select: { id: true, name: true, email: true } },
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
    select: { id: true },
  });

  if (recipients.length !== uniqueIds.length) {
    throw new HttpError(400, 'One or more recipient IDs are invalid');
  }

  return prisma.campaign.create({
    data: {
      name,
      subject,
      templateId,
      scheduledAt: new Date(scheduledAt),
      recipientIds: uniqueIds,
      notes: notes || '',
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

export async function deleteCampaign(id) {
  await getCampaignById(id);

  const rows = await prisma.campaignRecipient.findMany({
    where: { campaignId: id },
    select: { recipientId: true },
  });
  const campaign = await prisma.campaign.findUnique({
    where: { id },
    select: { recipientIds: true },
  });
  const recipientIds = new Set([...(campaign?.recipientIds || []), ...rows.map((row) => row.recipientId)]);

  for (const recipientId of recipientIds) {
    try {
      const job = await campaignQueue.getJob(sendJobId(id, recipientId));
      await job?.remove();
    } catch {
      // Job may already be gone.
    }
  }

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

  for (const recipient of recipients) {
    if (alreadyProcessedIds.has(recipient.id)) {
      skipped.alreadySent += 1;
      continue;
    }

    if (recipient.status === 'bounced' || recipient.status === 'unsubscribed') {
      skipped.inactive += 1;
      continue;
    }

    toSend.push(recipient);
  }

  if (toSend.length === 0) {
    const completed = await maybeCompleteCampaign(campaignId, step.id);
    return {
      campaign: completed || campaign,
      stepId: step.id,
      enqueued: 0,
      failed: 0,
      remaining: 0,
      skipped,
      errors: [],
    };
  }

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

  const batch = toSend.slice(0, SEND_BATCH_SIZE);
  let enqueued = 0;
  let failed = 0;
  const errors = [];

  for (const [index, recipient] of batch.entries()) {
    if (index > 0) {
      await sleep(SEND_GAP_MS);
    }
    try {
      await sendCampaignEmail({
        to: recipient.email,
        name: recipient.name,
        subject: step.subject,
        html: template.body,
        campaignId: campaign.id,
        recipientId: recipient.id,
        stepId: step.id,
        unsubscribeUrl: unsubscribeUrlFor(recipient.unsubscribeToken),
      });
      await recordSend({ campaignId: campaign.id, recipientId: recipient.id, stepId: step.id });
      enqueued += 1;
    } catch (err) {
      failed += 1;
      errors.push({ email: recipient.email, error: err.message });
      console.error(`[send] ${recipient.email}`, err.message);
      await recordBounce({
        campaignId: campaign.id,
        recipientId: recipient.id,
        stepId: step.id,
        error: err.message,
      });
    }
  }

  await maybeCompleteCampaign(campaignId, step.id);
  const updated = await getCampaignById(campaignId);
  const remaining = Math.max(0, toSend.length - batch.length);

  return {
    campaign: updated,
    stepId: step.id,
    enqueued,
    failed,
    remaining,
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
  const activePeople = livePeople.filter((person) => person.status === 'active');

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
      'Nobody left for this follow-up. Bounced, delayed, and removed contacts are skipped.'
    );
  }

  const stepNumber = last.stepNumber + 1;
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

export async function recordSend({ campaignId, recipientId, stepId }) {
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
    },
  });
}

export async function recordBounce({ campaignId, recipientId, error, stepId }) {
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
        },
      });
    }
  }

  let last = null;
  for (const row of rows) {
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
      .filter((person) => !processedIds.has(person.id))
      .map((person) => ({
        status: 'pending',
        error: 'Not sent yet',
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
  const addresses = await listGmailBounceAddresses();
  if (addresses.length === 0) {
    return { scanned: 0, marked: 0, emails: [] };
  }

  const recipients = await prisma.recipient.findMany({
    where: { email: { in: addresses } },
  });

  const emails = [];
  for (const recipient of recipients) {
    await prisma.recipient.update({
      where: { id: recipient.id },
      data: {
        status: 'bounced',
        lastError:
          recipient.lastError ||
          'Gmail reported this address as undeliverable or delayed.',
      },
    });

    const rows = await prisma.campaignRecipient.findMany({
      where: { recipientId: recipient.id },
    });

    for (const row of rows) {
      await recordBounce({
        campaignId: row.campaignId,
        recipientId: recipient.id,
        error: row.error || 'Gmail reported this address as undeliverable or delayed.',
      });
    }

    emails.push(recipient.email);
  }

  return { scanned: addresses.length, marked: emails.length, emails };
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

export async function listCampaignsWithStats() {
  const campaigns = await listCampaigns();
  if (campaigns.length === 0) {
    return [];
  }

  const campaignIds = campaigns.map((campaign) => campaign.id);
  const allAudienceIds = [...new Set(campaigns.flatMap((campaign) => [
    ...campaign.recipientIds,
    ...campaign.steps.flatMap((step) => step.recipientIds),
  ]))];
  const [grouped, rows, people] = await Promise.all([
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
      select: { id: true, status: true },
    }),
  ]);

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
          return person?.status === 'active' && !processed.has(id);
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
      if (currentStep && campaign.status !== currentStep.status) {
        await prisma.campaign.update({
          where: { id: campaign.id },
          data: { status: currentStep.status },
        });
        campaign.status = currentStep.status;
      }

      return {
        ...campaign,
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
      select: { id: true, status: true },
    }),
    prisma.campaignRecipient.findMany({
      where: { stepId: step.id },
      select: { recipientId: true },
    }),
  ]);
  const processedIds = new Set(processed.map((row) => row.recipientId));
  return existing.filter((row) => row.status === 'active' && !processedIds.has(row.id)).length;
}

export async function getDashboard() {
  const [campaigns, recipients, grouped] = await Promise.all([
    listCampaignsWithStats(),
    prisma.recipient.findMany(),
    prisma.campaignRecipient.groupBy({
      by: ['status'],
      _count: { _all: true },
    }),
  ]);

  const counts = emptyCounts();
  for (const row of grouped) {
    counts[row.status] = row._count._all;
  }
  const funnel = funnelFromCounts(counts);

  const bouncedRecipients = recipients.filter((r) => r.status === 'bounced').length;
  const unsubscribedRecipients = recipients.filter((r) => r.status === 'unsubscribed').length;

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
      bounceRate: funnel.bounceRate,
      bounced: funnel.bounced,
      pending: campaigns.reduce((sum, c) => sum + (c.totals?.pending || 0), 0),
    },
    recent: campaigns.slice(0, 8),
    upcoming,
    chart,
    bounceUnsub: {
      bounces: bouncedRecipients || funnel.bounced,
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

  return sendCampaignEmail({
    to,
    name: 'there',
    subject: `[Test] ${step.subject}`,
    html: template.body,
    campaignId: campaign.id,
    recipientId: 'test',
    stepId: step.id,
    unsubscribeUrl: `${env.appUrl}/unsubscribe.html`,
  });
}
