import dns from 'dns';
import { promisify } from 'util';

const resolveMx = promisify(dns.resolveMx);

const EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

export function isValidEmailSyntax(email) {
  if (!email || typeof email !== 'string') {
    return false;
  }
  
  const trimmed = email.trim();
  
  if (trimmed.length > 254) {
    return false;
  }
  
  if (!EMAIL_REGEX.test(trimmed)) {
    return false;
  }
  
  const [local, domain] = trimmed.split('@');
  if (!local || !domain || local.length > 64) {
    return false;
  }
  
  return true;
}

export async function checkEmailDomain(email) {
  if (!isValidEmailSyntax(email)) {
    return { valid: false, reason: 'Invalid email syntax' };
  }
  
  const domain = email.split('@')[1].toLowerCase();
  
  try {
    const records = await resolveMx(domain);
    if (!records || records.length === 0) {
      return { valid: false, reason: 'No MX records found for domain' };
    }
    return { valid: true };
  } catch (err) {
    const code = err.code;
    if (code === 'ENOTFOUND' || code === 'ENODATA') {
      return { valid: false, reason: 'Domain does not exist' };
    }
    if (code === 'ETIMEOUT') {
      return { valid: true, warning: 'DNS timeout, skipping check' };
    }
    return { valid: true, warning: `DNS check failed: ${err.message}` };
  }
}

export function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

export function deduplicateEmails(emails) {
  const seen = new Set();
  const unique = [];
  const duplicates = [];
  
  for (const email of emails) {
    const normalized = normalizeEmail(email);
    if (seen.has(normalized)) {
      duplicates.push(email);
    } else {
      seen.add(normalized);
      unique.push(email);
    }
  }
  
  return { unique, duplicates };
}

export async function validateEmailBatch(emails, options = {}) {
  const { checkDns = true, maxConcurrent = 10 } = options;
  const results = [];
  
  for (let i = 0; i < emails.length; i += maxConcurrent) {
    const batch = emails.slice(i, i + maxConcurrent);
    const batchResults = await Promise.all(
      batch.map(async (email) => {
        const normalized = normalizeEmail(email);
        
        if (!isValidEmailSyntax(normalized)) {
          return {
            email,
            valid: false,
            reason: 'Invalid email syntax',
          };
        }
        
        if (checkDns) {
          const dnsCheck = await checkEmailDomain(normalized);
          return {
            email,
            valid: dnsCheck.valid,
            reason: dnsCheck.reason,
            warning: dnsCheck.warning,
          };
        }
        
        return {
          email,
          valid: true,
        };
      })
    );
    results.push(...batchResults);
  }
  
  return results;
}
