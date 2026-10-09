import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const FALSE_BOUNCE_PATTERNS = [
  /rate.*limit/i,
  /quota.*exceeded/i,
  /too.*many.*requests/i,
  /insufficient.*permission/i,
  /invalid.*credentials/i,
  /unauthorized/i,
  /forbidden/i,
  /connect.*gmail/i,
  /gmail.*not.*connected/i,
  /temporary.*problem/i,
  /will.*try.*for/i,
  /delivery.*incomplete/i,
  /delay/i,
  /try.*again.*later/i,
  /still.*trying/i,
  /421/,
  /429/,
  /450/,
  /451/,
  /452/,
];

function isFalseBounce(error) {
  if (!error) return false;
  const message = String(error).toLowerCase();
  return FALSE_BOUNCE_PATTERNS.some(pattern => pattern.test(message));
}

async function analyzeBounces(dryRun = true) {
  console.log('Analyzing bounces...\n');
  
  const bouncedRecipients = await prisma.recipient.findMany({
    where: { status: 'bounced' },
    include: {
      campaignRecipients: {
        where: { status: 'bounced' },
        orderBy: { sentAt: 'desc' },
      },
    },
  });

  const stats = {
    totalBounced: bouncedRecipients.length,
    falseBounces: 0,
    realBounces: 0,
    uncertain: 0,
  };

  const toFix = [];

  for (const recipient of bouncedRecipients) {
    const latestBounce = recipient.campaignRecipients[0];
    const error = latestBounce?.error || recipient.lastError || '';
    
    if (isFalseBounce(error)) {
      stats.falseBounces++;
      toFix.push({
        email: recipient.email,
        recipientId: recipient.id,
        reason: error.slice(0, 100),
        bounceCount: recipient.campaignRecipients.length,
      });
    } else if (error.includes('gmail') || error.includes('Gmail')) {
      stats.realBounces++;
    } else if (!error || error.length < 10) {
      stats.uncertain++;
      console.log(`⚠️  Uncertain: ${recipient.email} - "${error}"`);
    } else {
      stats.realBounces++;
    }
  }

  console.log('Statistics:');
  console.log(`  Total bounced recipients: ${stats.totalBounced}`);
  console.log(`  False bounces (auth/rate/delay): ${stats.falseBounces}`);
  console.log(`  Real bounces: ${stats.realBounces}`);
  console.log(`  Uncertain: ${stats.uncertain}\n`);

  if (toFix.length > 0) {
    console.log('False bounces to fix:');
    for (const item of toFix.slice(0, 20)) {
      console.log(`  ${item.email}`);
      console.log(`    Reason: ${item.reason}`);
      console.log(`    Bounce records: ${item.bounceCount}\n`);
    }
    if (toFix.length > 20) {
      console.log(`  ... and ${toFix.length - 20} more\n`);
    }
  }

  if (!dryRun && toFix.length > 0) {
    console.log('Fixing false bounces...');
    let fixed = 0;
    for (const item of toFix) {
      await prisma.$transaction([
        prisma.recipient.update({
          where: { id: item.recipientId },
          data: { 
            status: 'active',
            lastError: `Previously marked as bounced due to send error: ${item.reason}`,
          },
        }),
        prisma.campaignRecipient.updateMany({
          where: { 
            recipientId: item.recipientId,
            status: 'bounced',
          },
          data: { 
            status: 'sent',
            error: `Previously marked as bounced due to send error: ${item.reason}`,
          },
        }),
      ]);
      fixed++;
    }
    console.log(`✓ Fixed ${fixed} false bounces`);
  } else if (toFix.length > 0) {
    console.log('To fix these false bounces, run:');
    console.log('  node scripts/fix-false-bounces.js --apply\n');
  }

  return stats;
}

const dryRun = !process.argv.includes('--apply');

analyzeBounces(dryRun)
  .catch((err) => {
    console.error('Error:', err);
    process.exit(1);
  })
  .finally(() => {
    prisma.$disconnect();
  });
