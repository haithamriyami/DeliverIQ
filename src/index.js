import { env } from './config/env.js';
import { prisma } from './lib/prisma.js';
import { campaignQueue } from './queues/campaignQueue.js';
import { createCampaignWorker } from './queues/workers/campaignWorker.js';
import { createApp } from './app.js';

const app = createApp();
createCampaignWorker();

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
