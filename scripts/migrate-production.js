import { execSync } from 'node:child_process';

const databaseUrl = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;

if (!databaseUrl) {
  console.log('Skipping Prisma migrate: DATABASE_URL is not set.');
  process.exit(0);
}

execSync('npx prisma migrate deploy', {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: databaseUrl },
});
