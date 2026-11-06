/**
 * Date-only scheduling helpers.
 *
 * All schedule fields are ISO date strings (YYYY-MM-DD) with no time component,
 * so they are timezone-free by design. "Today" and timestamps are resolved in
 * Australia/Sydney unless APP_TIMEZONE says otherwise.
 */

export const APP_TZ = process.env.APP_TIMEZONE || "Australia/Sydney";
export const DEFAULT_FISCAL_START_MONTH = 7; // July → FY27 = Jul 2026..Jun 2027

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function isoToday(tz = APP_TZ): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return parts; // en-CA yields YYYY-MM-DD
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function toUtc(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

export function fromDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  const d = toUtc(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return fromDate(d);
}

export function addMonths(iso: string, months: number): string {
  const d = toUtc(iso);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return fromDate(d);
}

export function diffDays(from: string, to: string): number {
  return Math.round((toUtc(to).getTime() - toUtc(from).getTime()) / 86400000);
}

/** Inclusive day count — source parity: Duration = End - Start + 1 calendar days. */
export function inclusiveDays(start: string, end: string): number {
  return diffDays(start, end) + 1;
}

export function isValidRange(start?: string | null, end?: string | null): boolean {
  return !!start && !!end && isIsoDate(start) && isIsoDate(end) && start <= end;
}

export function rangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

export function isWeekend(iso: string): boolean {
  const day = toUtc(iso).getUTCDay();
  return day === 0 || day === 6;
}

export function dayOfWeek(iso: string): number {
  return toUtc(iso).getUTCDay();
}

export function weekdayMon0(iso: string): number {
  return (dayOfWeek(iso) + 6) % 7; // Monday = 0
}

export function isWorkingDay(iso: string, holidays: Set<string> = new Set()): boolean {
  return !isWeekend(iso) && !holidays.has(iso);
}

export function addWorkingDays(iso: string, days: number, holidays: Set<string> = new Set()): string {
  let cursor = iso;
  const step = days >= 0 ? 1 : -1;
  let remaining = Math.abs(days);
  while (remaining > 0) {
    cursor = addDays(cursor, step);
    if (isWorkingDay(cursor, holidays)) remaining -= 1;
  }
  return cursor;
}

/** Next working day on/after a date (used for WORKDAY.INTL parity checks). */
export function nextWorkingDay(iso: string, holidays: Set<string> = new Set()): string {
  let cursor = iso;
  let guard = 0;
  while (!isWorkingDay(cursor, holidays) && guard < 14) {
    cursor = addDays(cursor, 1);
    guard += 1;
  }
  return cursor;
}

/**
 * Source deployment formula parity.
 * The legacy workbook computes: start + weeks*6, then a WORKDAY.INTL adjustment.
 * We reproduce that ordering rather than assuming weeks*5.
 */
export function sourceDeploymentDate(
  start: string,
  weeks: number,
  holidays: Set<string> = new Set()
): string {
  const candidate = addDays(start, Math.round(weeks * 6));
  return nextWorkingDay(candidate, holidays);
}

/* -------------------------------------------------------------------------- */
/* Fiscal calendar (FY27 = July 2026 – June 2027)                              */
/* -------------------------------------------------------------------------- */

export function fiscalYearOf(iso: string, startMonth = DEFAULT_FISCAL_START_MONTH) {
  const d = toUtc(iso);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const startYear = m >= startMonth ? y : y - 1;
  return { startYear, label: `FY${String((startYear + 1) % 100).padStart(2, "0")}` };
}

export function fiscalYearLabel(startYear: number) {
  return `FY${String((startYear + 1) % 100).padStart(2, "0")}`;
}

export function fiscalYearStartYearFromLabel(fy: string): number {
  const m = /^FY(\d{2})$/i.exec(fy.trim());
  if (!m) return new Date().getUTCFullYear();
  const two = parseInt(m[1], 10);
  const century = Math.floor(new Date().getUTCFullYear() / 100) * 100;
  const endYear = century + two;
  return endYear - 1;
}

export function fiscalYearBounds(startYear: number, startMonth = DEFAULT_FISCAL_START_MONTH) {
  const start = `${startYear}-${String(startMonth).padStart(2, "0")}-01`;
  const end = addDays(addMonths(start, 12), -1);
  return { start, end, label: fiscalYearLabel(startYear), startYear };
}

export function fiscalMonths(startYear: number, startMonth = DEFAULT_FISCAL_START_MONTH) {
  const first = `${startYear}-${String(startMonth).padStart(2, "0")}-01`;
  return Array.from({ length: 12 }, (_, i) => {
    const start = addMonths(first, i);
    return {
      index: i,
      key: start.slice(0, 7),
      label: monthLabel(start),
      short: shortMonth(start),
      start,
      end: addDays(addMonths(start, 1), -1),
      quarter: Math.floor(i / 3) + 1,
    };
  });
}

export function fiscalQuarters(startYear: number, startMonth = DEFAULT_FISCAL_START_MONTH) {
  const months = fiscalMonths(startYear, startMonth);
  return [1, 2, 3, 4].map((q) => {
    const qm = months.filter((m) => m.quarter === q);
    return {
      quarter: q,
      label: `Q${q} ${fiscalYearLabel(startYear)}`,
      start: qm[0].start,
      end: qm[qm.length - 1].end,
      months: qm,
    };
  });
}

export function monthLabel(iso: string) {
  return new Intl.DateTimeFormat("en-AU", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(toUtc(iso));
}

export function shortMonth(iso: string) {
  return new Intl.DateTimeFormat("en-AU", {
    month: "short",
    year: "2-digit",
    timeZone: "UTC",
  }).format(toUtc(iso));
}

export function formatDate(iso?: string | null, opts: Intl.DateTimeFormatOptions = {}) {
  if (!iso || !isIsoDate(iso)) return "—";
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
    ...opts,
  }).format(toUtc(iso));
}

export function formatDateShort(iso?: string | null) {
  return formatDate(iso, { year: undefined });
}

export function formatDayNumber(iso: string) {
  return String(toUtc(iso).getUTCDate());
}

export function weekdayShort(iso: string) {
  return new Intl.DateTimeFormat("en-AU", { weekday: "short", timeZone: "UTC" }).format(toUtc(iso));
}

/* -------------------------------------------------------------------------- */
/* Month grid                                                                  */
/* -------------------------------------------------------------------------- */

export type DayCell = {
  date: string;
  day: number;
  weekday: number;
  inMonth: boolean;
  isWeekend: boolean;
  isHoliday: boolean;
  holidayName?: string;
  isToday: boolean;
  isCurrentWeek: boolean;
  isPast: boolean;
};

export type MonthGrid = {
  monthKey: string;
  label: string;
  start: string;
  end: string;
  weeks: DayCell[][];
  workingDays: number;
};

export function monthStart(monthKey: string): string {
  return `${monthKey}-01`;
}

export function buildMonthGrid(
  monthKey: string,
  opts: { holidays?: Map<string, string>; today?: string } = {}
): MonthGrid {
  const today = opts.today ?? isoToday();
  const holidays = opts.holidays ?? new Map<string, string>();
  const first = monthStart(monthKey);
  const start = addDays(first, -weekdayMon0(first));
  const end = addDays(start, 41);
  const weeks: DayCell[][] = [];
  let cursor = start;
  let workingDays = 0;
  const currentWeekStart = addDays(today, -weekdayMon0(today));
  for (let w = 0; w < 6; w += 1) {
    const week: DayCell[] = [];
    for (let d = 0; d < 7; d += 1) {
      const inMonth = cursor.slice(0, 7) === monthKey;
      const weekend = isWeekend(cursor);
      if (inMonth && !weekend && !holidays.has(cursor)) workingDays += 1;
      week.push({
        date: cursor,
        day: toUtc(cursor).getUTCDate(),
        weekday: weekdayMon0(cursor),
        inMonth,
        isWeekend: weekend,
        isHoliday: holidays.has(cursor),
        holidayName: holidays.get(cursor),
        isToday: cursor === today,
        isCurrentWeek: cursor >= currentWeekStart && cursor <= addDays(currentWeekStart, 6),
        isPast: cursor < today,
      });
      cursor = addDays(cursor, 1);
    }
    weeks.push(week);
  }
  return { monthKey, label: monthLabel(first), start: first, end: addDays(addMonths(first, 1), -1), weeks, workingDays };
}

export function eachDay(start: string, end: string): string[] {
  const out: string[] = [];
  if (!isValidRange(start, end)) return out;
  let cursor = start;
  let guard = 0;
  while (cursor <= end && guard < 3660) {
    out.push(cursor);
    cursor = addDays(cursor, 1);
    guard += 1;
  }
  return out;
}

export function monthKeysBetween(start: string, end: string): string[] {
  const out: string[] = [];
  let cursor = `${start.slice(0, 7)}-01`;
  let guard = 0;
  while (cursor <= end && guard < 120) {
    out.push(cursor.slice(0, 7));
    cursor = addMonths(cursor, 1);
    guard += 1;
  }
  return out;
}
