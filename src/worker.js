import { prisma } from './lib/prisma.js';
import { createCampaignWorker } from './queues/workers/campaignWorker.js';

const worker = createCampaignWorker();

console.log('DeliverIQ campaign worker started');

async function shutdown() {
  console.log('Shutting down worker...');
  await worker.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
