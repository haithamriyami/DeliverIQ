import { env } from './env.js';

/**
 * Is a real SendGrid API key set (SENDGRID_API_KEY)? The key itself is only read by
 * src/services/sendgridService.js and never leaves the server. Having a key does not send
 * anything: SendGrid only sends for a workspace whose owner switched it on in Settings.
 */
export const sendgridKeyConfigured =
  Boolean(env.sendgrid.apiKey) && !env.sendgrid.apiKey.startsWith('placeholder');

/** Old name, kept for callers. Means the key is set, not that sending is on. */
export const sendgridEnabled = sendgridKeyConfigured;
