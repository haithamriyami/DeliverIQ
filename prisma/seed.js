import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const template = await prisma.template.upsert({
    where: { id: '00000000-0000-4000-8000-000000000001' },
    update: {},
    create: {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'Welcome',
      body: '<p>Hi {{name}},</p><p>Welcome to DeliverIQ. Smart global campaigns, clean lists, guaranteed delivery.</p>',
    },
  });

  await prisma.template.upsert({
    where: { id: '00000000-0000-4000-8000-000000000002' },
    update: {},
    create: {
      id: '00000000-0000-4000-8000-000000000002',
      name: 'Follow-up',
      body: '<p>Hi {{name}},</p><p>Just checking in. If you have questions, reply to this email.</p>',
    },
  });

  await prisma.recipient.upsert({
    where: { email: 'ada@example.com' },
    update: { notes: 'Met at launch event' },
    create: {
      email: 'ada@example.com',
      name: 'Ada Lovelace',
      timezone: 'America/New_York',
      notes: 'Met at launch event',
    },
  });

  await prisma.recipient.upsert({
    where: { email: 'alan@example.com' },
    update: { notes: 'Follow up after webinar' },
    create: {
      email: 'alan@example.com',
      name: 'Alan Turing',
      timezone: 'Europe/London',
      notes: 'Follow up after webinar',
    },
  });

  console.log('Seeded templates and sample recipients');
  console.log('Welcome template id', template.id);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
