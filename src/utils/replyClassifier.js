/**
 * Classify an inbound message in a campaign thread.
 * Returns 'auto_reply' | 'opt_out' | 'reply'.
 * Auto replies are checked first so an out of office that happens to say
 * "stop" or "unsubscribe" is never treated as a human opt out.
 */

function headerValue(headers, name) {
  const lower = name.toLowerCase();
  if (!headers) return '';
  if (Array.isArray(headers)) {
    return String(headers.find((h) => String(h?.name || '').toLowerCase() === lower)?.value || '');
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return String(value || '');
  }
  return '';
}

const AUTO_SUBJECT_RE =
  /\b(automatic reply|auto(?:matic)?[- ]?(?:reply|response|responder)|autoreply|out of (?:the )?office|ooo|away from (?:the )?office|on vacation|on leave|on holiday|annual leave|maternity leave|currently away|i am away|i'm away|abwesenheit|absence|r[ée]ponse automatique|respuesta autom[áa]tica|fuera de la oficina)\b/i;

const AUTO_BODY_RE =
  /\b(this is an automatic(?:ally generated)? (?:reply|response|message)|i am (?:currently )?out of (?:the )?office|i'm (?:currently )?out of (?:the )?office|i will be out of (?:the )?office|i am currently away|i'm currently away|i will be away|i am on (?:annual |maternity |paternity )?leave|limited access to (?:my )?email|will respond (?:to your (?:email|message) )?(?:when|upon) (?:i|my) return|i will reply when i return|thank you for your (?:email|message)[.,!]? (?:this is|i am|i'm) (?:an )?(?:automat|away|out))/i;

/** Remove quoted history and our own footer so only the new text is checked. */
export function stripQuoted(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const kept = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^on .+wrote:\s*$/i.test(trimmed)) break;
    if (/^-{2,}\s*original message\s*-{2,}/i.test(trimmed)) break;
    if (/^from:\s.+/i.test(trimmed) && kept.length) break;
    if (/^_{5,}$/.test(trimmed)) break;
    if (/don.t want these emails\?/i.test(trimmed)) break;
    if (trimmed.startsWith('>')) continue;
    kept.push(line);
  }
  return kept.join('\n').trim();
}

export function isAutoReply({ subject = '', body = '', headers = {} } = {}) {
  const autoSubmitted = headerValue(headers, 'Auto-Submitted').toLowerCase();
  if (autoSubmitted && autoSubmitted !== 'no') return true;
  if (headerValue(headers, 'X-Autoreply')) return true;
  if (headerValue(headers, 'X-Autorespond')) return true;
  if (headerValue(headers, 'X-Auto-Response-Suppress') && AUTO_SUBJECT_RE.test(subject)) return true;
  const precedence = headerValue(headers, 'Precedence').toLowerCase();
  if (precedence === 'auto_reply') return true;
  if (AUTO_SUBJECT_RE.test(subject)) return true;
  if (AUTO_BODY_RE.test(stripQuoted(body))) return true;
  return false;
}

const OPT_OUT_RE =
  /\b(not interested|no longer interested|unsubscribe|remove me|take me off|opt(?:[- ])?out|do not (?:contact|email|e-mail) me|don't (?:contact|email|e-mail) me|stop (?:emailing|contacting|sending|messaging)|please stop)\b/i;

export function isOptOut({ subject = '', body = '' } = {}) {
  const fresh = stripQuoted(body);
  const cleanSubject = String(subject || '').replace(/^\s*((re|fwd?|aw|sv)\s*:\s*)+/i, '');
  if (OPT_OUT_RE.test(fresh) || /^\s*(unsubscribe|stop|remove( me)?)\s*[.!]*\s*$/i.test(cleanSubject)) {
    return true;
  }
  // A bare "stop" (or "STOP." etc.) as the whole reply or its first line.
  const firstLine = fresh.split('\n').find((line) => line.trim()) || '';
  if (/^\s*stop\b[\s.!]*$/i.test(firstLine) || /^\s*stop[\s.!]*$/i.test(fresh)) {
    return true;
  }
  return false;
}

export function classifyReply(message = {}) {
  if (isAutoReply(message)) return 'auto_reply';
  if (isOptOut(message)) return 'opt_out';
  return 'reply';
}
