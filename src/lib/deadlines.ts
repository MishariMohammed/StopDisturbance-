import { tz } from "@date-fns/tz";
import { addDays, addMonths, endOfDay, isWeekend } from "date-fns";

// Deadline maths (00-brief §5 "Deadline maths", 00-review D8, 03-legal §5/M7). Pure functions.
// Every computed instant is the END of a calendar day in Asia/Riyadh.

export const DEADLINE_TZ = "Asia/Riyadh";
const inTz = tz(DEADLINE_TZ);
const plain = (d: Date) => new Date(d.getTime());

export function endOfDayRiyadh(d: Date): Date {
  return plain(endOfDay(d, { in: inTz }));
}

/** Riyadh calendar date of `start` + n days, end of day. */
export function addCalendarDays(start: Date, n: number): Date {
  return endOfDayRiyadh(addDays(start, n, { in: inTz }));
}

/** Same day number n months later; if that day does not exist, the last day of that month (31 Jan → 28/29 Feb). */
export function addCalendarMonths(start: Date, n: number): Date {
  return endOfDayRiyadh(addMonths(start, n, { in: inTz }));
}

/** n business days later, counting Mon–Fri only, no holiday calendar (CAN-SPAM; 00-brief §5). */
export function addBusinessDays(start: Date, n: number): Date {
  let d: Date = start;
  let counted = 0;
  while (counted < n) {
    d = addDays(d, 1, { in: inTz });
    if (!isWeekend(d, { in: inTz })) counted++;
  }
  return endOfDayRiyadh(d);
}

type Rule =
  | { unit: "days"; n: number; extension: number }
  | { unit: "months"; n: number; extension: number }
  | { unit: "businessDays"; n: number; extension: 0 };

/** Tracked deadlines per law key (keys from lib/legal/jurisdiction). Laws without a fixed deadline are not tracked. */
export const DEADLINE_RULES: Readonly<Record<string, Rule>> = {
  PDPL: { unit: "days", n: 30, extension: 30 }, // IR Art. 4
  GDPR: { unit: "months", n: 1, extension: 2 }, // Art. 12(3)
  UK_GDPR: { unit: "months", n: 1, extension: 2 },
  CAN_SPAM: { unit: "businessDays", n: 10, extension: 0 }, // opt-out only
  CCPA: { unit: "days", n: 45, extension: 45 }, // §1798.130(a)(2); only when Owner.usState is set
  US_STATE: { unit: "days", n: 45, extension: 45 }, // other state laws (03 §3)
  CA_PIPEDA: { unit: "days", n: 30, extension: 30 }, // s.8(3)
  CA_CASL: { unit: "businessDays", n: 10, extension: 0 }, // s.11(3)
};

export function ruleFor(lawKey: string): Rule | undefined {
  return DEADLINE_RULES[lawKey.startsWith("US_STATE_") ? "US_STATE" : lawKey];
}

function apply(unit: Rule["unit"], start: Date, n: number): Date {
  if (unit === "days") return addCalendarDays(start, n);
  if (unit === "months") return addCalendarMonths(start, n);
  return addBusinessDays(start, n);
}

export interface LawDeadline {
  law: string;
  base: Date;
  /** Deadline after a validly notified extension, else null. */
  extended: Date | null;
  effective: Date;
}

/**
 * One law's deadline. The extension counts only if the company's notice is dated inside the original period
 * (PDPL IR Art. 4; GDPR Art. 12(3)). Extensions run from clockStart (GDPR: 1 + 2 = 3 months, month-end clamped).
 */
export function lawDeadline(law: string, clockStart: Date, extensionNoticeAt: Date | null = null): LawDeadline | null {
  const rule = ruleFor(law);
  if (!rule) return null;
  const base = apply(rule.unit, clockStart, rule.n);
  const extended =
    rule.extension > 0 && extensionNoticeAt && extensionNoticeAt.getTime() <= base.getTime()
      ? apply(rule.unit, clockStart, rule.n + rule.extension)
      : null;
  return { law, base, extended, effective: extended ?? base };
}

export interface DeadlineInput {
  /** Provider send time, or the web-form "I submitted it" date. */
  clockStart: Date;
  lawKeys: readonly string[];
  /** Date of the company's extension notice, if the owner recorded one. */
  extensionNoticeAt?: Date | null;
  reminderSentAt?: Date | null;
}

export interface DeadlineResult {
  /** Earliest applicable deadline (OVERDUE). */
  dueAt: Date;
  /** Latest applicable deadline including notified extensions. */
  latestDueAt: Date;
  /** Latest validly extended deadline, if any extension applies. */
  extendedDueAt: Date | null;
  /** dueAt + 3 days (max 1 reminder). */
  reminderOfferedAt: Date;
  /** max(reminderSentAt + 7 days, latestDueAt); null until a reminder has been sent (03 S3). */
  escalationOpenAt: Date | null;
  /** SDAIA window: PDPL due (incl. extension) + 90 days. */
  complaintWindowEndsAt: Date | null;
  perLaw: LawDeadline[];
}

const latest = (ds: Date[]) => new Date(Math.max(...ds.map((d) => d.getTime())));
const earliest = (ds: Date[]) => new Date(Math.min(...ds.map((d) => d.getTime())));

export function computeDeadlines(input: DeadlineInput): DeadlineResult {
  const notice = input.extensionNoticeAt ?? null;
  let perLaw = input.lawKeys.map((k) => lawDeadline(k, input.clockStart, notice)).filter((x): x is LawDeadline => x !== null);
  // Unknown jurisdiction (03 §5 row 10) still tracks the PDPL 30 days.
  if (perLaw.length === 0) perLaw = [lawDeadline("PDPL", input.clockStart, notice)!];

  const effective = perLaw.map((l) => l.effective);
  const dueAt = earliest(effective);
  const latestDueAt = latest(effective);
  const extendedList = perLaw.flatMap((l) => (l.extended ? [l.extended] : []));
  const extendedDueAt = extendedList.length ? latest(extendedList) : null;
  const reminderOfferedAt = addCalendarDays(dueAt, 3);
  const escalationOpenAt = input.reminderSentAt ? latest([addCalendarDays(input.reminderSentAt, 7), latestDueAt]) : null;
  const pdpl = perLaw.find((l) => l.law === "PDPL");
  const complaintWindowEndsAt = pdpl ? addCalendarDays(pdpl.effective, 90) : null;

  return { dueAt, latestDueAt, extendedDueAt, reminderOfferedAt, escalationOpenAt, complaintWindowEndsAt, perLaw };
}
