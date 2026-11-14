import { opsError } from './operations-contracts.mjs';

export function validateSchedule(schedule) {
  if (!schedule) return null;
  try { new Intl.DateTimeFormat('en', { timeZone: schedule.timezone }).format(); } catch { throw opsError('INVALID_TIMEZONE', 'Schedule needs a valid IANA timezone'); }
  if (!schedule.timezone || !Number.isFinite(Date.parse(schedule.nextAt)) || !Number.isSafeInteger(schedule.intervalMs) || schedule.intervalMs < 1000 ||
      !['once', 'skip'].includes(schedule.misfire) || !Number.isSafeInteger(schedule.maxRunsPerWindow) || schedule.maxRunsPerWindow < 1) {
    throw opsError('INVALID_SCHEDULE', 'Schedule needs nextAt, intervalMs >= 1000, once/skip misfire and frequency cap');
  }
  if (schedule.allowedWindow && (!/^\d{2}:\d{2}$/u.test(schedule.allowedWindow.start) || !/^\d{2}:\d{2}$/u.test(schedule.allowedWindow.end) ||
      [schedule.allowedWindow.start, schedule.allowedWindow.end].some((value) => +value.slice(0, 2) > 23 || +value.slice(3) > 59))) throw opsError('INVALID_SCHEDULE_WINDOW', 'Allowed window must contain valid HH:MM start/end');
  if (schedule.expiresAt && !Number.isFinite(Date.parse(schedule.expiresAt))) throw opsError('INVALID_SCHEDULE', 'Schedule expiry is invalid');
  return structuredClone(schedule);
}
export function scheduleDue(schedule, now) {
  if (!schedule || Date.parse(schedule.nextAt) > now || (schedule.expiresAt && Date.parse(schedule.expiresAt) <= now)) return null;
  const date = new Date(now);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: schedule.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date).map((part) => [part.type, part.value]));
  const localTime = `${parts.hour}:${parts.minute}`;
  const window = schedule.allowedWindow;
  const allowed = !window || (window.start <= window.end ? localTime >= window.start && localTime < window.end : localTime >= window.start || localTime < window.end);
  const windowKey = `${parts.year}-${parts.month}-${parts.day}`;
  const runs = schedule.windowKey === windowKey ? schedule.windowRuns || 0 : 0;
  const driftMs = now - Date.parse(schedule.nextAt);
  const fire = allowed && runs < schedule.maxRunsPerWindow && !(schedule.misfire === 'skip' && driftMs >= schedule.intervalMs);
  return { fire, driftMs, next: { ...schedule, nextAt: new Date(now + schedule.intervalMs).toISOString(), windowKey, windowRuns: runs + (fire ? 1 : 0) } };
}
