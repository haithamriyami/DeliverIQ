import { execSync } from 'node:child_process';
import { env } from './config/env.js';
import { prisma } from './lib/prisma.js';
import { campaignQueue } from './queues/campaignQueue.js';
import { createCampaignWorker } from './queues/workers/campaignWorker.js';
import { createApp } from './app.js';

if (env.nodeEnv === 'production') {
  try {
    execSync('npx prisma migrate deploy', { stdio: 'inherit' });
  } catch (err) {
    console.error('Prisma migrate failed:', err.message);
  }
}

const app = createApp();

if (process.env.REDIS_URL || env.nodeEnv !== 'production') {
  createCampaignWorker();
}

const server = app.listen(env.port, () => {
  console.log(`DeliverIQ API listening on http://localhost:${env.port}`);
  console.log('Smart global campaigns, clean lists, guaranteed delivery.');
});

async function shutdown() {
  console.log('Shutting down API...');
  server.close();
  await campaignQueue.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
