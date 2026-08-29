const partFormatterCache = new Map();

function formatter(timeZone) {
  if (!partFormatterCache.has(timeZone)) {
    partFormatterCache.set(timeZone, new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "long",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    }));
  }
  return partFormatterCache.get(timeZone);
}

export function zonedParts(value, timeZone) {
  const date = value instanceof Date ? value : new Date(value);
  return Object.fromEntries(
    formatter(timeZone)
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
}

export function localDateKey(value, timeZone) {
  const parts = zonedParts(value, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function addDateKey(dateKey, days) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days, 12));
  return date.toISOString().slice(0, 10);
}

export function weekdayForDateKey(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" })
    .format(new Date(Date.UTC(year, month - 1, day)))
    .toLowerCase();
}

// Convert an unambiguous salon-local wall-clock time to an instant without a
// timezone dependency. Salon appointments do not occur during the DST fold.
export function zonedDateTime(dateKey, time, timeZone = "Europe/Zurich") {
  const [year, month, day] = dateKey.split("-").map(Number);
  const [hour, minute, second = 0] = time.split(":").map(Number);
  const desired = Date.UTC(year, month - 1, day, hour, minute, second);
  let instant = desired;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = zonedParts(new Date(instant), timeZone);
    const observed = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second)
    );
    const correction = desired - observed;
    instant += correction;
    if (correction === 0) break;
  }

  return new Date(instant);
}

export function minutesOfDay(value, timeZone) {
  const parts = zonedParts(value, timeZone);
  return Number(parts.hour) * 60 + Number(parts.minute);
}

export function isQuietTime(value, timeZone, quietHours) {
  const minute = minutesOfDay(value, timeZone);
  const [startHour, startMinute] = quietHours.start.split(":").map(Number);
  const [endHour, endMinute] = quietHours.end.split(":").map(Number);
  const start = startHour * 60 + startMinute;
  const end = endHour * 60 + endMinute;
  return start > end ? minute >= start || minute < end : minute >= start && minute < end;
}

export function nextQuietEnd(value, timeZone, quietHours) {
  if (!isQuietTime(value, timeZone, quietHours)) return new Date(value);
  const date = value instanceof Date ? value : new Date(value);
  const parts = zonedParts(date, timeZone);
  const currentDate = `${parts.year}-${parts.month}-${parts.day}`;
  const [endHour, endMinute] = quietHours.end.split(":").map(Number);
  const currentMinute = Number(parts.hour) * 60 + Number(parts.minute);
  const end = endHour * 60 + endMinute;
  const endDate = currentMinute < end ? currentDate : addDateKey(currentDate, 1);
  return zonedDateTime(endDate, quietHours.end, timeZone);
}

function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

function dateKeyWithOffset(date, days) {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy.toISOString().slice(0, 10);
}

export function swissHolidaySet(year, region = "") {
  const easter = easterSunday(year);
  const dates = new Set([
    `${year}-01-01`,
    `${year}-08-01`,
    `${year}-12-25`,
    `${year}-12-26`,
    dateKeyWithOffset(easter, -2),
    dateKeyWithOffset(easter, 1),
    dateKeyWithOffset(easter, 39),
    dateKeyWithOffset(easter, 50)
  ]);
  if (region === "ZH") {
    dates.add(`${year}-01-02`);
    dates.add(`${year}-05-01`);
  }
  return dates;
}

export function formatSpoken(value, timeZone, options = {}) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...options
  }).format(new Date(value));
}

export function normaliseSlug(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    // Drop apostrophes so "Men's Cut" == "Mens Cut" (voice STT / LLMs vary).
    .replace(/['‘’ʼ`]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
