import { execSync } from 'node:child_process';

// Only production builds may change the database schema. Preview builds share the
// production DATABASE_URL through the Neon integration, so running migrations there
// would change the live database before a pull request is merged.
const vercelEnv = process.env.VERCEL_ENV;
if (vercelEnv && vercelEnv !== 'production' && process.env.RUN_MIGRATIONS !== '1') {
  console.log(`Skipping Prisma migrate: VERCEL_ENV is "${vercelEnv}", migrations run only on production builds.`);
  process.exit(0);
}

const databaseUrl = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;

if (!databaseUrl) {
  console.log('Skipping Prisma migrate: DATABASE_URL is not set.');
  process.exit(0);
}

execSync('npx prisma migrate deploy', {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: databaseUrl },
});
