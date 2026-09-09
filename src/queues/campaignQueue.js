import { Queue } from 'bullmq';
import { redisConnection } from '../config/redis.js';

export const CAMPAIGN_QUEUE_NAME = 'campaign-send';

function queueEnabled() {
  return Boolean(process.env.REDIS_URL) || (process.env.NODE_ENV ?? 'development') !== 'production';
}

let campaignQueueInstance = null;

function getQueue() {
  if (!queueEnabled()) {
    return null;
  }
  if (!campaignQueueInstance) {
    campaignQueueInstance = new Queue(CAMPAIGN_QUEUE_NAME, {
      connection: redisConnection,
    });
    campaignQueueInstance.on('error', (err) => {
      console.error('[queue]', err.message);
    });
  }
  return campaignQueueInstance;
}

export const campaignQueue = {
  async getJob(id) {
    const queue = getQueue();
    if (!queue) return null;
    return queue.getJob(id);
  },
  async close() {
    if (campaignQueueInstance) {
      await campaignQueueInstance.close();
      campaignQueueInstance = null;
    }
  },
};

export function sendJobId(campaignId, recipientId) {
  return `${campaignId}__${recipientId}`;
}
