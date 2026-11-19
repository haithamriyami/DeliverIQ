/**
 * Gmail error helpers.
 *
 * Gmail's "Units per minute per user" quota (metric "Total Query Cost") is shared by every
 * Gmail API call of the account: reading the inbox AND sending. Hitting it only means
 * "slow down for a minute"; it says nothing about the account's standing. So it is a
 * short backoff, never a pause. Only real sending problems pause the sender.
 */

function errorParts(err) {
  const status = Number(err?.code || err?.status || err?.response?.status || 0);
  const message = String(err?.message || err || '').toLowerCase();
  const reasons = (err?.errors || err?.response?.data?.error?.errors || [])
    .map((e) => `${String(e?.reason || '')} ${String(e?.message || '')}`.toLowerCase())
    .join(' ');
  return { status, blob: `${message} ${reasons}` };
}

const POLICY_RE =
  /suspend|disabled|policy|abuse|terms of service|account.*(restricted|blocked|locked)|domainpolicy|sending.*(restricted|blocked)/;
// Gmail's sending limits for the account (per day), as opposed to API call rate.
const SENDING_LIMIT_RE =
  /dailylimitexceeded|daily user sending (quota|limit)|sending (quota|limit) (exceeded|reached)|mail sending limit|exceeded.*sending limit|user has exceeded the maximum number of (messages|recipients)/;
// Short term API rate or quota: per minute units, per user rate, too many requests.
const TRANSIENT_QUOTA_RE =
  /units per minute|per minute|total query cost|quota exceeded|ratelimitexceeded|userratelimitexceeded|rate.?limit|too many requests|concurrent requests|backenderror|quota/;

/** Per minute or per user API quota / rate error: back off, never pause. */
export function isTransientQuotaError(err) {
  const { status, blob } = errorParts(err);
  if (POLICY_RE.test(blob) || SENDING_LIMIT_RE.test(blob)) return false;
  return status === 429 || TRANSIENT_QUOTA_RE.test(blob);
}

/** Milliseconds from a Retry-After header, if Gmail sent one. */
export function retryAfterMs(err, now = Date.now()) {
  const headers = err?.response?.headers || err?.headers || {};
  const raw = typeof headers.get === 'function' ? headers.get('retry-after') : headers['retry-after'] ?? headers['Retry-After'];
  if (raw == null || raw === '') return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(String(raw));
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/** Exponential backoff: base * 2^(attempt-1), at least Retry-After, at most max. */
export function backoffMs(attempt, { baseMs = 60000, maxMs = 30 * 60000, retryAfter = null } = {}) {
  const exp = baseMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(maxMs, Math.max(exp, retryAfter || 0));
}

// Clear problems with this one address. Anything else is not a bounce.
const RECIPIENT_RE =
  /invalid to header|invalid cc header|invalid bcc header|invalid recipient|recipient address required|recipient.*reject|address.*(rejected|invalid|malformed)|invalid.*(?:email|address)|malformed.*address/;

/** Gmail 404 when a thread or message id is not in this account's mailbox. */
export function isThreadNotFoundError(err) {
  const { status, blob } = errorParts(err);
  if (status === 404) return true;
  return /requested entity was not found|entity was not found|threadid.*(not found|invalid)|thread (id )?(was )?not found|\bnotfound\b/.test(blob);
}

/**
 * Classify a Gmail send failure.
 * - sender_block: policy, suspension, disabled account, or the account's daily sending limit. Pause.
 * - transient: per minute / per user API quota or rate limit. Back off a little, do not pause.
 * - auth: token revoked or Gmail not connected. Pause until reconnect.
 * - recipient: a clear problem with this one address (treated as a bounce).
 * - send_error: sender side or API failure (404 thread not found, 5xx, network). Not a bounce.
 */
export function classifySendError(err) {
  const { status, blob } = errorParts(err);
  if (POLICY_RE.test(blob) || SENDING_LIMIT_RE.test(blob)) return 'sender_block';
  if (isTransientQuotaError(err)) return 'transient';
  if (
    status === 401 ||
    /invalid_grant|invalid.*credentials|insufficient|unauthorized|token.*(expired|revoked)|gmail.*not.*connected|connect.*gmail/.test(blob)
  ) {
    return 'auth';
  }
  if (status === 403 || /forbidden|permission/.test(blob)) return 'auth';
  if (RECIPIENT_RE.test(blob)) return 'recipient';
  // 404, 5xx, network, leftover thread errors, and other unclassified API failures
  // are not the contact's fault, so they must not be recorded as bounces.
  return 'send_error';
}

/** Pause reasons written by the old code for a per minute quota error. Safe to auto resume. */
export const QUOTA_PAUSE_MARKERS = ['Units per minute', 'Total Query Cost', 'Quota exceeded for quota metric'];

export function isQuotaOnlyPauseReason(reason) {
  const text = String(reason || '');
  if (!text) return false;
  if (POLICY_RE.test(text.toLowerCase().replace(/rate limit, policy or account restriction/g, ''))) return false;
  return QUOTA_PAUSE_MARKERS.some((marker) => text.includes(marker));
}

export function senderPauseMessage(kind, err) {
  const detail = String(err?.message || '').slice(0, 300);
  if (kind === 'auth') {
    return `Gmail refused the send because access needs to be reconnected. Reconnect Gmail in Settings, then press Resume. Gmail said: ${detail}`;
  }
  return `Gmail returned a sending limit, policy or account restriction error, so all sending from this account is paused. Check the Gmail account, then press Resume. Gmail said: ${detail}`;
}
