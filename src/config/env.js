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

function trimSlash(url) {
  return String(url || '').replace(/\/+$/, '');
}

/**
 * Public base URL used in tracking pixels, click links and unsubscribe links.
 * APP_URL wins. On Vercel without APP_URL, fall back to the production domain (or the
 * deployment URL) so emails never point at 127.0.0.1, and warn so APP_URL gets set.
 */
export function resolveAppUrl(source = process.env) {
  if (source.APP_URL) {
    return trimSlash(source.APP_URL);
  }
  const vercelHost = source.VERCEL_PROJECT_PRODUCTION_URL || source.VERCEL_URL;
  if (vercelHost) {
    const url = trimSlash(/^https?:\/\//i.test(vercelHost) ? vercelHost : `https://${vercelHost}`);
    console.warn(`[env] APP_URL is not set, using ${url} for tracking and unsubscribe links. Set APP_URL to be sure.`);
    return url;
  }
  return `http://127.0.0.1:${source.PORT ?? 3000}`;
}

const appUrl = resolveAppUrl();

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 3000),
  appUrl,
  sessionSecret: process.env.SESSION_SECRET ?? 'deliveriq-dev-session-secret-change-me',
  databaseUrl: required('DATABASE_URL', 'postgresql://deliveriq:deliveriq@127.0.0.1:5433/deliveriq?schema=public'),
  redis: redisConfig(),
  sendgrid: {
    apiKey: process.env.SENDGRID_API_KEY ?? 'placeholder-sendgrid-api-key',
    // Default From address and name for the SendGrid sender. Settings can override them per workspace.
    fromEmail: process.env.SENDGRID_FROM_EMAIL ?? '',
    fromName: process.env.SENDGRID_FROM_NAME ?? '',
    webhookVerificationKey: process.env.SENDGRID_WEBHOOK_VERIFICATION_KEY ?? '',
    // Only shown in the app for old setups. SendGrid sending is switched on per workspace in Settings.
    dryRun: (process.env.SENDGRID_DRY_RUN ?? 'true') === 'true',
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    redirectUri: `${appUrl}/auth/google/callback`,
  },
  // Vercel Cron sends "Authorization: Bearer $CRON_SECRET" automatically when set.
  cronSecret: process.env.CRON_SECRET ?? '',
};
