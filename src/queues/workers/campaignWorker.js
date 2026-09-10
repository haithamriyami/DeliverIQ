import { Worker } from 'bullmq';
import { prisma } from '../../lib/prisma.js';
import { redisConnection } from '../../config/redis.js';
import { CAMPAIGN_QUEUE_NAME } from '../campaignQueue.js';
import { sendCampaignEmail, unsubscribeUrlFor } from '../../services/emailService.js';
import { maybeCompleteCampaign, recordBounce, recordSend } from '../../services/campaignService.js';

export function createCampaignWorker() {
  const worker = new Worker(
    CAMPAIGN_QUEUE_NAME,
    async (job) => {
      const { campaignId, recipientId } = job.data;

      const [campaign, recipient] = await Promise.all([
        prisma.campaign.findUnique({
          where: { id: campaignId },
          include: { template: true },
        }),
        prisma.recipient.findUnique({ where: { id: recipientId } }),
      ]);

      if (!campaign) {
        throw new Error(`Campaign ${campaignId} not found`);
      }

      if (!recipient) {
        return { skipped: true, reason: 'recipient_missing' };
      }

      if (recipient.status === 'bounced' || recipient.status === 'unsubscribed') {
        return { skipped: true, reason: 'inactive_recipient' };
      }

      const alreadySent = await prisma.campaignRecipient.findFirst({
        where: {
          campaignId,
          recipientId,
          status: { in: ['sent', 'opened', 'clicked'] },
        },
      });

      if (alreadySent) {
        return { skipped: true, reason: 'already_sent' };
      }

      try {
        await sendCampaignEmail({
          to: recipient.email,
          name: recipient.name,
          subject: campaign.subject,
          html: campaign.template.body,
          campaignId,
          recipientId,
          unsubscribeUrl: unsubscribeUrlFor(recipient.unsubscribeToken),
        });
      } catch (err) {
        await recordBounce({ campaignId, recipientId, error: err.message });
        throw err;
      }

      await recordSend({ campaignId, recipientId });
      await maybeCompleteCampaign(campaignId);

      return { skipped: false, recipientId, campaignId };
    },
    {
      connection: redisConnection,
      concurrency: 10,
    }
  );

  worker.on('completed', (job, result) => {
    console.log(`[worker] job ${job.id} completed`, result);
  });

  worker.on('failed', (job, err) => {
    console.error(`[worker] job ${job?.id} failed`, err.message);
  });

  return worker;
}
