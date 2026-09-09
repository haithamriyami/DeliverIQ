import { DateTime } from 'luxon';

/**
 * Treat campaign.scheduledAt clock components as local wall-clock time
 * in the recipient timezone (e.g. 09:00 means 9am local, everywhere).
 */
export function getLocalSendDate(scheduledAt, timezone = 'UTC') {
  const utc = DateTime.fromJSDate(scheduledAt, { zone: 'utc' });

  return DateTime.fromObject(
    {
      year: utc.year,
      month: utc.month,
      day: utc.day,
      hour: utc.hour,
      minute: utc.minute,
      second: utc.second,
    },
    { zone: timezone || 'UTC' }
  );
}

export function getSendDelayMs(scheduledAt, timezone = 'UTC') {
  const localSend = getLocalSendDate(scheduledAt, timezone);
  return Math.max(0, localSend.toUTC().toMillis() - Date.now());
}
