import { Queue } from 'bullmq';
import { redisConnection } from '../config/redis.js';

export const CAMPAIGN_QUEUE_NAME = 'campaign-send';

export const campaignQueue = new Queue(CAMPAIGN_QUEUE_NAME, {
  connection: redisConnection,
});

campaignQueue.on('error', (err) => {
  console.error('[queue]', err.message);
});

export function sendJobId(campaignId, recipientId) {
  return `${campaignId}__${recipientId}`;
}
