const ETHIOPIAN_MONTHS = [
  'Meskerem', 'Tikimt', 'Hidar', 'Tahsas', 'Tir', 'Yekatit', 'Megabit',
  'Miazia', 'Ginbot', 'Sene', 'Hamle', 'Nehasse', 'Pagume',
];

function parseDateKey(dateKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey))) return null;
  const date = new Date(`${dateKey}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function calendarParts(date, calendar) {
  const parts = new Intl.DateTimeFormat(`en-US-u-ca-${calendar}-nu-latn`, {
    timeZone: 'Africa/Addis_Ababa',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(date);
  return Object.fromEntries(parts
    .filter((part) => ['year', 'month', 'day'].includes(part.type))
    .map((part) => [part.type, Number(part.value)]));
}

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

export function getOrthodoxEasterDate(year) {
  const a = year % 4;
  const b = year % 7;
  const c = year % 19;
  const d = (19 * c + 15) % 30;
  const e = (2 * a + 4 * b - d + 34) % 7;
  const julianMonth = Math.floor((d + e + 114) / 31);
  const julianDay = ((d + e + 114) % 31) + 1;
  const gregorianDate = new Date(Date.UTC(year, julianMonth - 1, julianDay));
  const calendarOffset = Math.floor(year / 100) - Math.floor(year / 400) - 2;
  gregorianDate.setUTCDate(gregorianDate.getUTCDate() + calendarOffset);
  return dateKey(gregorianDate);
}

export function getAttendanceCalendarDay(dateKeyValue) {
  const date = parseDateKey(dateKeyValue);
  if (!date) return null;

  const ethiopian = calendarParts(date, 'ethiopic');
  const islamic = calendarParts(date, 'islamic');
  const weekday = date.getUTCDay();
  const year = date.getUTCFullYear();
  const easter = new Date(`${getOrthodoxEasterDate(year)}T12:00:00Z`);
  const goodFriday = new Date(easter);
  goodFriday.setUTCDate(goodFriday.getUTCDate() - 2);
  const lentStart = new Date(easter);
  lentStart.setUTCDate(lentStart.getUTCDate() - 55);
  const events = [];
  const fasting = [];

  if (ethiopian.month === 1 && ethiopian.day === 1) events.push('Ethiopian New Year');
  if (ethiopian.month === 1 && ethiopian.day === 17) events.push('Meskel (Finding of the True Cross)');
  if (ethiopian.month === 4 && ethiopian.day === 29) events.push('Ethiopian Christmas (Genna)');
  if (ethiopian.month === 5 && ethiopian.day === 11) events.push('Epiphany (Timket)');
  if (ethiopian.month === 6 && ethiopian.day === 23) events.push('Adwa Victory Day');
  if (ethiopian.month === 8 && ethiopian.day === 23) events.push('International Labour Day');
  if (ethiopian.month === 8 && ethiopian.day === 27) events.push('Patriots Victory Day');
  if (ethiopian.month === 9 && ethiopian.day === 20) events.push('Downfall of the Derg');
  if (dateKeyValue === dateKey(goodFriday)) events.push('Orthodox Good Friday');
  if (dateKeyValue === dateKey(easter)) events.push('Orthodox Easter (Fasika)');

  if (date >= lentStart && date < easter) fasting.push('Orthodox Great Lent');
  if (islamic.month === 9) fasting.push('Ramadan');
  if (islamic.month === 10 && islamic.day === 1) events.push('Eid al-Fitr');
  if (islamic.month === 12 && islamic.day === 10) events.push('Eid al-Adha');

  return {
    weekday,
    isSunday: weekday === 0,
    ethiopianDate: `${ETHIOPIAN_MONTHS[ethiopian.month - 1] || 'Ethiopian'} ${ethiopian.day}`,
    events,
    fasting,
  };
}