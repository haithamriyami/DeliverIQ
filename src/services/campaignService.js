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
    },
    include: { template: true, createdBy: { select: { id: true, name: true, email: true } } },
  });
}

export async function listCampaigns() {
  return prisma.campaign.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      template: { select: { id: true, name: true } },
      createdBy: { select: { id: true, name: true, email: true } },
    },
  });
}

export async function getCampaignById(id) {
  const campaign = await prisma.campaign.findUnique({
    where: { id },
    include: { template: true, createdBy: { select: { id: true, name: true, email: true } } },
  });

  if (!campaign) {
    throw new HttpError(404, 'Campaign not found');
  }

  return campaign;
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

export async function enqueueCampaign(campaignId) {
  const campaign = await getCampaignById(campaignId);

  const recipients = await prisma.recipient.findMany({
    where: { id: { in: campaign.recipientIds } },
  });

  const alreadyProcessed = await prisma.campaignRecipient.findMany({
    where: { campaignId },
    select: { recipientId: true },
  });
  const alreadyProcessedIds = new Set(alreadyProcessed.map((row) => row.recipientId));

  const skipped = {
    alreadySent: 0,
    inactive: 0,
    missing: campaign.recipientIds.length - recipients.length,
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
    const completed = await maybeCompleteCampaign(campaignId);
    return {
      campaign: completed || campaign,
      enqueued: 0,
      failed: 0,
      remaining: 0,
      skipped,
      errors: [],
    };
  }

  await prisma.campaign.update({
    where: { id: campaignId },
    data: { status: 'sending' },
  });

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
        subject: campaign.subject,
        html: campaign.template.body,
        campaignId: campaign.id,
        recipientId: recipient.id,
        unsubscribeUrl: unsubscribeUrlFor(recipient.unsubscribeToken),
      });
      await recordSend({ campaignId: campaign.id, recipientId: recipient.id });
      enqueued += 1;
    } catch (err) {
      failed += 1;
      errors.push({ email: recipient.email, error: err.message });
      console.error(`[send] ${recipient.email}`, err.message);
      await recordBounce({
        campaignId: campaign.id,
        recipientId: recipient.id,
        error: err.message,
      });
    }
  }

  await maybeCompleteCampaign(campaignId);
  const updated = await getCampaignById(campaignId);
  const remaining = Math.max(0, toSend.length - batch.length);

  return {
    campaign: updated,
    enqueued,
    failed,
    remaining,
    skipped,
    errors,
  };
}

export async function maybeCompleteCampaign(campaignId) {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
  });

  if (!campaign || campaign.status === 'completed') {
    return campaign;
  }

  const sentRecords = await prisma.campaignRecipient.findMany({
    where: { campaignId },
    select: { recipientId: true },
  });
  const processedIds = new Set(sentRecords.map((row) => row.recipientId));

  const existing = await prisma.recipient.findMany({
    where: { id: { in: campaign.recipientIds } },
    select: { id: true, status: true },
  });
  const liveIds = existing.map((row) => row.id);
  if (liveIds.length !== campaign.recipientIds.length) {
    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { recipientIds: liveIds },
    });
  }

  const remaining = existing.filter((row) => row.status === 'active' && !processedIds.has(row.id));

  if (remaining.length === 0) {
    return prisma.campaign.update({
      where: { id: campaignId },
      data: { status: 'completed' },
    });
  }

  return campaign;
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
  const livePending = await livePendingCount(campaign);
  const funnel = funnelFromCounts(counts, {
    audienceSize: campaign.recipientIds.length,
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

export async function recordSend({ campaignId, recipientId }) {
  const existing = await prisma.campaignRecipient.findUnique({
    where: {
      campaignId_recipientId: { campaignId, recipientId },
    },
  });

  if (!existing) {
    return prisma.campaignRecipient.create({
      data: {
        campaignId,
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

export async function recordBounce({ campaignId, recipientId, error }) {
  const reason = String(error || 'Bounced').slice(0, 500);

  await prisma.recipient.update({
    where: { id: recipientId },
    data: { status: 'bounced', lastError: reason },
  });

  const existing = await prisma.campaignRecipient.findUnique({
    where: {
      campaignId_recipientId: { campaignId, recipientId },
    },
  });

  if (!existing) {
    return prisma.campaignRecipient.create({
      data: {
        campaignId,
        recipientId,
        status: 'bounced',
        error: reason,
        sentAt: new Date(),
      },
    });
  }

  return prisma.campaignRecipient.update({
    where: { id: existing.id },
    data: {
      status: 'bounced',
      error: reason,
    },
  });
}

export async function listCampaignAudience(campaignId, kind = 'sent') {
  const campaign = await getCampaignById(campaignId);

  if (kind === 'pending') {
    const processed = await prisma.campaignRecipient.findMany({
      where: { campaignId },
      select: { recipientId: true },
    });
    const processedIds = new Set(processed.map((row) => row.recipientId));
    const people = await prisma.recipient.findMany({
      where: {
        id: { in: campaign.recipientIds },
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
      ? { campaignId, status: 'bounced' }
      : { campaignId, status: { in: ['sent', 'opened', 'clicked'] } };

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
        lastError: recipient.lastError || 'Gmail reported this address as undeliverable.',
      },
    });

    const rows = await prisma.campaignRecipient.findMany({
      where: { recipientId: recipient.id },
    });

    for (const row of rows) {
      await recordBounce({
        campaignId: row.campaignId,
        recipientId: recipient.id,
        error: row.error || 'Gmail reported this address as undeliverable.',
      });
    }

    emails.push(recipient.email);
  }

  return { scanned: addresses.length, marked: emails.length, emails };
}

export async function applyEngagementEvent({ campaignId, recipientId, event }) {
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

  const existing = await prisma.campaignRecipient.findUnique({
    where: {
      campaignId_recipientId: { campaignId, recipientId },
    },
  });

  if (!existing) {
    return prisma.campaignRecipient.create({
      data: {
        campaignId,
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
  const [grouped, rows, people] = await Promise.all([
    prisma.campaignRecipient.groupBy({
      by: ['campaignId', 'status'],
      _count: { _all: true },
    }),
    prisma.campaignRecipient.findMany({
      where: { campaignId: { in: campaignIds } },
      select: { campaignId: true, recipientId: true },
    }),
    prisma.recipient.findMany({
      where: { id: { in: [...new Set(campaigns.flatMap((campaign) => campaign.recipientIds))] } },
      select: { id: true, status: true },
    }),
  ]);

  const byCampaign = new Map();
  for (const row of grouped) {
    if (!byCampaign.has(row.campaignId)) {
      byCampaign.set(row.campaignId, emptyCounts());
    }
    byCampaign.get(row.campaignId)[row.status] = row._count._all;
  }

  const processedByCampaign = new Map();
  for (const row of rows) {
    if (!processedByCampaign.has(row.campaignId)) {
      processedByCampaign.set(row.campaignId, new Set());
    }
    processedByCampaign.get(row.campaignId).add(row.recipientId);
  }

  const peopleById = new Map(people.map((person) => [person.id, person]));

  const reconciled = await Promise.all(
    campaigns.map(async (campaign) => {
      const liveIds = campaign.recipientIds.filter((id) => peopleById.has(id));
      if (liveIds.length !== campaign.recipientIds.length) {
        await prisma.campaign.update({
          where: { id: campaign.id },
          data: { recipientIds: liveIds },
        });
        campaign.recipientIds = liveIds;
      }

      const processed = processedByCampaign.get(campaign.id) || new Set();
      const pending = liveIds.filter((id) => {
        const person = peopleById.get(id);
        return person?.status === 'active' && !processed.has(id);
      }).length;

      if (pending === 0 && campaign.status === 'sending') {
        await prisma.campaign.update({
          where: { id: campaign.id },
          data: { status: 'completed' },
        });
        campaign.status = 'completed';
      }

      const totals = funnelFromCounts(byCampaign.get(campaign.id) || emptyCounts(), {
        audienceSize: liveIds.length,
        pending,
      });
      return {
        ...campaign,
        totals: {
          sent: totals.sent,
          bounced: totals.bounced,
          opened: totals.opened,
          clicked: totals.clicked,
          pending: totals.pending,
        },
        rates: {
          bounceRate: totals.bounceRate,
          openRate: totals.openRate,
          clickRate: totals.clickRate,
        },
      };
    })
  );

  return reconciled;
}

async function livePendingCount(campaign) {
  const [existing, processed] = await Promise.all([
    prisma.recipient.findMany({
      where: { id: { in: campaign.recipientIds } },
      select: { id: true, status: true },
    }),
    prisma.campaignRecipient.findMany({
      where: { campaignId: campaign.id },
      select: { recipientId: true },
    }),
  ]);
  const processedIds = new Set(processed.map((row) => row.recipientId));
  const liveIds = existing.map((row) => row.id);
  if (liveIds.length !== campaign.recipientIds.length) {
    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { recipientIds: liveIds },
    });
    campaign.recipientIds = liveIds;
  }
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

  return sendCampaignEmail({
    to,
    name: 'there',
    subject: `[Test] ${campaign.subject}`,
    html: campaign.template.body,
    campaignId: campaign.id,
    recipientId: 'test',
    unsubscribeUrl: `${env.appUrl}/unsubscribe.html`,
  });
}
