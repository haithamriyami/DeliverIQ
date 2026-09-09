import dotenv from 'dotenv';

dotenv.config();

function redisConfig() {
  const url = process.env.REDIS_URL;
  if (url) {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      port: Number(parsed.port || 6379),
      username: parsed.username || undefined,
      password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
      tls: parsed.protocol === 'rediss:' ? {} : undefined,
    };
  }

  return {
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD || undefined,
  };
}

function required(name, fallback = undefined) {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 3000),
  appUrl: process.env.APP_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`,
  sessionSecret: process.env.SESSION_SECRET ?? 'deliveriq-dev-session-secret-change-me',
  databaseUrl: required('DATABASE_URL', 'postgresql://deliveriq:deliveriq@127.0.0.1:5433/deliveriq?schema=public'),
  redis: redisConfig(),
  sendgrid: {
    apiKey: process.env.SENDGRID_API_KEY ?? 'placeholder-sendgrid-api-key',
    fromEmail: process.env.SENDGRID_FROM_EMAIL ?? 'hello@deliveriq.local',
    fromName: process.env.SENDGRID_FROM_NAME ?? 'DeliverIQ',
    webhookVerificationKey: process.env.SENDGRID_WEBHOOK_VERIFICATION_KEY ?? '',
    dryRun: (process.env.SENDGRID_DRY_RUN ?? 'true') === 'true',
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    redirectUri:
      process.env.GOOGLE_REDIRECT_URI ??
      `${process.env.APP_URL ?? 'http://127.0.0.1:3000'}/auth/google/callback`,
  },
};
