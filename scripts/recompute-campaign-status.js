// Idempotent status repair. Counts are computed live from campaign_recipients, so this only
// fixes step/campaign statuses (older steps left in "sending" after a follow-up exists).
// Dry run by default:   node scripts/recompute-campaign-status.js
// Apply:                node scripts/recompute-campaign-status.js --apply
// The app also runs this automatically every time the campaign list loads.
import { prisma } from '../src/lib/prisma.js';
import { reconcileCampaignSteps, listCampaignsWithStats } from '../src/services/campaignService.js';

const apply = process.argv.includes('--apply');
const changed = await reconcileCampaignSteps({ apply });
console.log(`${apply ? 'Marked completed' : 'Would mark completed'}: ${changed.length} superseded step(s)`);
for (const row of changed) console.log(`  ${row.campaign} step ${row.stepNumber}`);
if (apply) {
  const campaigns = await listCampaignsWithStats();
  for (const c of campaigns) {
    console.log(`  ${c.name}: ${c.status}, ${c.totals.sent} sent, ${c.totals.pending} not sent (all emails: ${c.allSteps.sent} sent)`);
  }
}
await prisma.$disconnect();
