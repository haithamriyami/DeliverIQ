import { Worker } from 'bullmq';
import { redisConnection } from '../../config/redis.js';
import { CAMPAIGN_QUEUE_NAME } from '../campaignQueue.js';
import { runSchedulerTick } from '../../services/campaignService.js';

const LOOP_MS = 5000;

/**
 * Long running hosts (local dev, Render) call the same throttled tick on an interval.
 * The per sender slot in Postgres keeps the per account gap and daily cap,
 * even if a Vercel cron tick runs at the same time.
 */
export function startSendLoop() {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await runSchedulerTick({ budgetMs: 0 });
    } catch (err) {
      console.error('[send-loop]', err.message);
    } finally {
      running = false;
    }
  }, LOOP_MS);
  return { close: () => clearInterval(timer) };
}

/**
 * Legacy BullMQ worker. Old jobs no longer send directly: any job just runs one
 * throttled tick so nothing can bypass the gap or daily cap.
 */
export function createCampaignWorker() {
  const worker = new Worker(
    CAMPAIGN_QUEUE_NAME,
    async () => runSchedulerTick({ budgetMs: 0 }),
    { connection: redisConnection, concurrency: 1 }
  );
  worker.on('failed', (job, err) => {
    console.error(`[worker] job ${job?.id} failed`, err.message);
  });
  const loop = startSendLoop();
  const close = worker.close.bind(worker);
  worker.close = async () => {
    loop.close();
    return close();
  };
  return worker;
}
