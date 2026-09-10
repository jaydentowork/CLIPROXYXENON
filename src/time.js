// Calendar reporting boundaries for the dashboard.
//
// Reporting follows the user's wall clock, so period starts are computed in the
// reporting time zone rather than the host time zone. Days start at local
// midnight, weeks start Monday, and months start on the first.

export const REPORTING_TIME_ZONE = 'America/Chicago';
export const PERIODS = ['today', 'week', 'month'];

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const formatters = new Map();

function formatterFor(timeZone) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

function zonedParts(ms, timeZone) {
  const parts = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const part of formatterFor(timeZone).formatToParts(new Date(ms))) {
    if (part.type in parts) parts[part.type] = Number(part.value);
  }
  return parts;
}

// Offset of the zone at an instant, in milliseconds east of UTC.
function zoneOffsetMs(ms, timeZone) {
  const truncated = Math.floor(ms / 1000) * 1000;
  const parts = zonedParts(truncated, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - truncated;
}

// Converts a wall-clock time in the zone to the UTC instant it names. The second
// pass settles the daylight-saving offset for boundaries near a transition.
export function zonedTimeToUtcMs(wallClock, timeZone = REPORTING_TIME_ZONE) {
  const { year, month, day, hour = 0, minute = 0, second = 0 } = wallClock;
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  let instant = guess - zoneOffsetMs(guess, timeZone);
  instant = guess - zoneOffsetMs(instant, timeZone);
  return instant;
}

export function isPeriod(value) {
  return PERIODS.includes(value);
}

export function periodStartMs(period, nowMs = Date.now(), timeZone = REPORTING_TIME_ZONE) {
  if (!isPeriod(period)) throw new RangeError(`Unsupported reporting period: ${String(period)}`);
  const parts = zonedParts(nowMs, timeZone);
  if (period === 'today') {
    return zonedTimeToUtcMs({ year: parts.year, month: parts.month, day: parts.day }, timeZone);
  }
  if (period === 'month') {
    return zonedTimeToUtcMs({ year: parts.year, month: parts.month, day: 1 }, timeZone);
  }
  const localDate = Date.UTC(parts.year, parts.month - 1, parts.day);
  const daysSinceMonday = (new Date(localDate).getUTCDay() + 6) % 7;
  const monday = new Date(localDate - daysSinceMonday * MS_PER_DAY);
  return zonedTimeToUtcMs(
    { year: monday.getUTCFullYear(), month: monday.getUTCMonth() + 1, day: monday.getUTCDate() },
    timeZone,
  );
}
