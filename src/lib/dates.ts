export const DAY_MS = 24 * 60 * 60 * 1000;

export function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export function addMinutes(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 60_000);
}

export function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

/** @param weekStartsOn 0 = Sunday, 1 = Monday */
export function startOfWeek(d: Date, weekStartsOn: number): Date {
  const x = startOfDay(d);
  return addDays(x, -((x.getDay() - weekStartsOn + 7) % 7));
}

export function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Whole days from `a` to `b`, ignoring DST shifts. */
export function dayDiff(a: Date, b: Date): number {
  return Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / DAY_MS);
}

/** Minutes since local midnight. */
export function minuteOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * Where `d` falls on `day`'s clock face, in minutes (0 to 1440). Uses the time shown on the clock,
 * not the time elapsed since midnight, so a 25-hour or 23-hour day (DST change) still lines up
 * with the hour labels. Times before or after the day are clamped to its edges.
 */
export function clockMinute(d: Date, day: Date): number {
  if (d.getTime() <= startOfDay(day).getTime()) return 0;
  if (d.getTime() >= atMinute(day, 24 * 60).getTime()) return 24 * 60;
  return minuteOfDay(d) + d.getSeconds() / 60;
}

/** Local midnight of `day` plus `minutes` (DST-safe). */
export function atMinute(day: Date, minutes: number): Date {
  const x = startOfDay(day);
  x.setMinutes(minutes);
  return x;
}

/** Parses a Google all-day date ("2026-10-16") as local midnight. */
export function parseDateOnly(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** Local "YYYY-MM-DD". */
export function toDateOnly(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local "HH:MM". */
export function toTimeOnly(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function fromDateAndTime(date: string, time: string): Date {
  const [h, m] = time.split(":").map(Number);
  return atMinute(parseDateOnly(date), h * 60 + m);
}

export function isWeekend(d: Date): boolean {
  return d.getDay() === 0 || d.getDay() === 6;
}

export const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
