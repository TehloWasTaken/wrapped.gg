export const BIRTHDAY_WINDOW_DAYS = 7;

const DAY = 86400;
const daysBetween = (a, b) => Math.floor((b - a) / DAY);
const startOfDay = (t) => Math.floor(t / DAY) * DAY;

function anniversary(bornAt, n) {
  const b = new Date(bornAt * 1000);
  const y = b.getUTCFullYear() + n, m = b.getUTCMonth(), d = b.getUTCDate();
  const t = Date.UTC(y, m, d) / 1000;
  if (new Date(t * 1000).getUTCMonth() !== m) return Date.UTC(y, m, d - 1) / 1000;
  return t;
}

export function worldAge(bornAt, at = Math.floor(Date.now() / 1000)) {
  const born = Number(bornAt);
  if (!born || !Number.isFinite(born) || born <= 0) return null;

  const today = startOfDay(at);
  const from = startOfDay(born);
  if (from > today) return null;

  const ageDays = daysBetween(from, today);
  let years = 0;
  while (anniversary(from, years + 1) <= today) years += 1;

  const lastAt = years >= 1 ? anniversary(from, years) : null;
  const nextAt = anniversary(from, years + 1);
  const sinceLast = lastAt === null ? null : daysBetween(lastAt, today);

  const isBirthday = years >= 1 && sinceLast >= 0 && sinceLast < BIRTHDAY_WINDOW_DAYS;

  return {
    born_at: from,
    age_days: ageDays,
    day_number: ageDays + 1,
    age_years: years,
    is_birthday: isBirthday,
    turning: isBirthday ? years : null,
    days_since: sinceLast,
    days_until: daysBetween(today, nextAt),
    next_at: nextAt,
    next_age: years + 1,
  };
}

export function parseWorldBorn(value) {
  if (value === null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0 ? startOfDay(Math.floor(value)) : null;
  }
  if (typeof value !== 'string') return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return undefined;
  const y = +m[1], mo = +m[2] - 1, d = +m[3];
  const t = Date.UTC(y, mo, d) / 1000;
  const back = new Date(t * 1000);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo || back.getUTCDate() !== d) {
    return undefined;
  }
  if (y < 2009 || t > Date.now() / 1000) return undefined;
  return t;
}

export function formatWorldBorn(bornAt) {
  if (!bornAt) return null;
  return new Date(bornAt * 1000).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}
