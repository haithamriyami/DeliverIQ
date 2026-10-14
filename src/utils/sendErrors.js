/**
 * Classify a Gmail send failure.
 * - sender_block: rate limit, policy, suspended or disabled account. Pause the whole sender.
 * - auth: token revoked or Gmail not connected. Pause the sender until reconnect.
 * - recipient: problem with this one address (treated as a bounce).
 */
export function classifySendError(err) {
  const status = Number(err?.code || err?.status || err?.response?.status || 0);
  const message = String(err?.message || err || '').toLowerCase();
  const reasons = (err?.errors || err?.response?.data?.error?.errors || [])
    .map((e) => String(e?.reason || '').toLowerCase())
    .join(' ');
  const blob = `${message} ${reasons}`;

  if (
    status === 429 ||
    /rate.?limit|too many requests|quota|userratelimitexceeded|dailylimitexceeded|limit exceeded/.test(blob) ||
    /suspend|disabled|policy|abuse|terms of service|account.*(restricted|blocked|locked)|domainpolicy|sending.*(restricted|blocked)/.test(blob)
  ) {
    return 'sender_block';
  }
  if (
    status === 401 ||
    /invalid_grant|invalid.*credentials|insufficient|unauthorized|token.*(expired|revoked)|gmail.*not.*connected|connect.*gmail/.test(blob)
  ) {
    return 'auth';
  }
  if (status === 403 || /forbidden|permission/.test(blob)) {
    return 'auth';
  }
  return 'recipient';
}

export function senderPauseMessage(kind, err) {
  const detail = String(err?.message || '').slice(0, 300);
  if (kind === 'auth') {
    return `Gmail refused the send because access needs to be reconnected. Reconnect Gmail in Settings, then press Resume. Gmail said: ${detail}`;
  }
  return `Gmail returned a rate limit, policy or account restriction error, so all sending from this account is paused. Check the Gmail account, then press Resume. Gmail said: ${detail}`;
}
