import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

dotenv.config();

const prisma = new PrismaClient();
const nextPassword = process.env.RESET_PASSWORD;

if (!nextPassword || nextPassword.length < 8) {
  throw new Error('RESET_PASSWORD missing');
}

const owner = await prisma.user.findFirst({
  where: { role: 'owner' },
  orderBy: { createdAt: 'asc' },
});

if (!owner) {
  throw new Error('No owner account found');
}

await prisma.user.update({
  where: { id: owner.id },
  data: { passwordHash: await bcrypt.hash(nextPassword, 10) },
});

console.log(`RESET_OK ${owner.email}`);
await prisma.$disconnect();
