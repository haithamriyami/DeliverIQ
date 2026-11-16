import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Local development only. Puts sample data in a "Demo" workspace so it never mixes with real work.
async function main() {
  const workspace =
    (await prisma.workspace.findFirst({ where: { name: 'Demo' } })) ||
    (await prisma.workspace.create({ data: { name: 'Demo' } }));
  const workspaceId = workspace.id;

  const template = await prisma.template.upsert({
    where: { id: '00000000-0000-4000-8000-000000000001' },
    update: {},
    create: {
      id: '00000000-0000-4000-8000-000000000001',
      workspaceId,
      name: 'Welcome',
      body: '<p>Hi {{name}},</p><p>Welcome to DeliverIQ. Smart global campaigns, clean lists, guaranteed delivery.</p>',
    },
  });

  await prisma.template.upsert({
    where: { id: '00000000-0000-4000-8000-000000000002' },
    update: {},
    create: {
      id: '00000000-0000-4000-8000-000000000002',
      workspaceId,
      name: 'Follow-up',
      body: '<p>Hi {{name}},</p><p>Just checking in. If you have questions, reply to this email.</p>',
    },
  });

  const list = await prisma.contactList.upsert({
    where: { workspaceId_name: { workspaceId, name: 'Agencies' } },
    update: {},
    create: { workspaceId, name: 'Agencies' },
  });

  for (const person of [
    { email: 'ada@example.com', name: 'Ada Lovelace', timezone: 'America/New_York', notes: 'Met at launch event' },
    { email: 'alan@example.com', name: 'Alan Turing', timezone: 'Europe/London', notes: 'Follow up after webinar' },
  ]) {
    await prisma.recipient.upsert({
      where: { workspaceId_email: { workspaceId, email: person.email } },
      update: { notes: person.notes },
      create: { ...person, workspaceId, listId: list.id },
    });
  }

  console.log('Seeded the Demo workspace with templates and sample recipients');
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
