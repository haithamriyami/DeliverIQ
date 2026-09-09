import sgMail from '@sendgrid/mail';
import { env } from './env.js';

const isPlaceholderKey =
  !env.sendgrid.apiKey || env.sendgrid.apiKey.startsWith('placeholder');

export const sendgridEnabled = !isPlaceholderKey && !env.sendgrid.dryRun;

if (sendgridEnabled) {
  sgMail.setApiKey(env.sendgrid.apiKey);
}

export { sgMail };
