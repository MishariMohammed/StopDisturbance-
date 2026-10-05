import { describe, expect, it } from "vitest";
import {
  addBusinessDays,
  addCalendarDays,
  addCalendarMonths,
  computeDeadlines,
  endOfDayRiyadh,
  lawDeadline,
  ruleFor,
} from "@/lib/deadlines";

/** End of the given calendar day in Asia/Riyadh (UTC+3, no DST). */
const eod = (ymd: string) => new Date(`${ymd}T23:59:59.999+03:00`);
const at = (iso: string) => new Date(iso);

// Monday 5 Oct 2026, 10:00 Riyadh.
const MON = at("2026-10-05T10:00:00+03:00");

describe("calendar helpers (end of day, Asia/Riyadh)", () => {
  it("endOfDayRiyadh uses the Riyadh calendar date, not UTC", () => {
    expect(endOfDayRiyadh(at("2026-10-05T22:30:00Z"))).toEqual(eod("2026-10-06")); // 01:30 on 6 Oct in Riyadh
    expect(endOfDayRiyadh(at("2026-10-05T20:59:59Z"))).toEqual(eod("2026-10-05"));
  });

  it("adds calendar days", () => {
    expect(addCalendarDays(MON, 30)).toEqual(eod("2026-11-04"));
    expect(addCalendarDays(at("2026-10-05T22:30:00Z"), 30)).toEqual(eod("2026-11-05"));
  });

  it("adds calendar months with month-end clamp (31 Jan → 28 Feb; leap year 29 Feb)", () => {
    expect(addCalendarMonths(at("2027-01-31T12:00:00+03:00"), 1)).toEqual(eod("2027-02-28"));
    expect(addCalendarMonths(at("2028-01-31T12:00:00+03:00"), 1)).toEqual(eod("2028-02-29"));
    expect(addCalendarMonths(at("2026-10-15T12:00:00+03:00"), 1)).toEqual(eod("2026-11-15"));
    expect(addCalendarMonths(at("2027-01-31T12:00:00+03:00"), 3)).toEqual(eod("2027-04-30"));
    // Riyadh date decides: 23:30Z on 30 Apr is 1 May in Riyadh.
    expect(addCalendarMonths(at("2027-04-30T23:30:00Z"), 1)).toEqual(eod("2027-06-01"));
  });

  it("adds business days Mon–Fri across weekends", () => {
    expect(addBusinessDays(MON, 10)).toEqual(eod("2026-10-19")); // Mon → Mon two weeks later
    const fri = at("2026-10-09T10:00:00+03:00");
    expect(addBusinessDays(fri, 1)).toEqual(eod("2026-10-12"));
    expect(addBusinessDays(fri, 10)).toEqual(eod("2026-10-23"));
    expect(addBusinessDays(at("2026-10-10T10:00:00+03:00"), 10)).toEqual(eod("2026-10-23")); // Saturday start
    expect(addBusinessDays(at("2026-10-11T10:00:00+03:00"), 10)).toEqual(eod("2026-10-23")); // Sunday start
    expect(addBusinessDays(MON, 0)).toEqual(eod("2026-10-05"));
  });
});

describe("lawDeadline", () => {
  it("knows the tracked laws", () => {
    expect(ruleFor("PDPL")).toMatchObject({ unit: "days", n: 30, extension: 30 });
    expect(ruleFor("US_STATE_VA")).toMatchObject({ unit: "days", n: 45 });
    expect(ruleFor("CST_ANTISPAM")).toBeUndefined();
    expect(lawDeadline("UAE_PDPL", MON)).toBeNull();
  });

  it("PDPL: +30, extension to +60 only with a notice dated inside the original period", () => {
    expect(lawDeadline("PDPL", MON)).toEqual({ law: "PDPL", base: eod("2026-11-04"), extended: null, effective: eod("2026-11-04") });
    expect(lawDeadline("PDPL", MON, at("2026-10-20T09:00:00+03:00"))!.effective).toEqual(eod("2026-12-04"));
    expect(lawDeadline("PDPL", MON, eod("2026-11-04"))!.extended).toEqual(eod("2026-12-04")); // last moment still inside
    expect(lawDeadline("PDPL", MON, at("2026-11-05T09:00:00+03:00"))).toMatchObject({ extended: null, effective: eod("2026-11-04") });
  });

  it("GDPR: +1 month, +2 more months if notified within the first month (month-end clamp)", () => {
    const jan31 = at("2027-01-31T12:00:00+03:00");
    expect(lawDeadline("GDPR", jan31)!.base).toEqual(eod("2027-02-28"));
    expect(lawDeadline("GDPR", jan31, at("2027-02-10T12:00:00+03:00"))!.effective).toEqual(eod("2027-04-30"));
    expect(lawDeadline("UK_GDPR", at("2028-01-31T12:00:00+03:00"))!.base).toEqual(eod("2028-02-29"));
  });

  it("CAN-SPAM: 10 business days, never extended", () => {
    expect(lawDeadline("CAN_SPAM", MON, at("2026-10-06T12:00:00+03:00"))).toMatchObject({ base: eod("2026-10-19"), extended: null });
  });

  it("CCPA / other state laws: 45 (+45)", () => {
    expect(lawDeadline("CCPA", MON, at("2026-10-10T12:00:00+03:00"))!.effective).toEqual(eod("2027-01-03"));
    expect(lawDeadline("US_STATE_VA", MON)!.effective).toEqual(eod("2026-11-19"));
  });
});

describe("computeDeadlines", () => {
  it("dueAt = earliest, latestDueAt = latest; reminder at dueAt + 3 days", () => {
    const r = computeDeadlines({ clockStart: MON, lawKeys: ["PDPL", "GDPR", "CAN_SPAM"] });
    expect(r.dueAt).toEqual(eod("2026-10-19"));
    expect(r.latestDueAt).toEqual(eod("2026-11-05")); // GDPR one month beats PDPL 30 days here
    expect(r.extendedDueAt).toBeNull();
    expect(r.reminderOfferedAt).toEqual(eod("2026-10-22"));
    expect(r.escalationOpenAt).toBeNull();
    expect(r.complaintWindowEndsAt).toEqual(eod("2027-02-02")); // PDPL due 4 Nov + 90
    expect(r.perLaw.map((l) => l.law)).toEqual(["PDPL", "GDPR", "CAN_SPAM"]);
  });

  it("PDPL only: due and latest are the same day", () => {
    const r = computeDeadlines({ clockStart: MON, lawKeys: ["PDPL", "CST_ANTISPAM"], extensionNoticeAt: null, reminderSentAt: null });
    expect(r.dueAt).toEqual(eod("2026-11-04"));
    expect(r.latestDueAt).toEqual(eod("2026-11-04"));
    expect(r.reminderOfferedAt).toEqual(eod("2026-11-07"));
  });

  it("escalationOpenAt = max(reminderSentAt + 7 days, latestDueAt)", () => {
    const late = computeDeadlines({ clockStart: MON, lawKeys: ["PDPL"], reminderSentAt: at("2026-11-08T10:00:00+03:00") });
    expect(late.escalationOpenAt).toEqual(eod("2026-11-15"));
    const early = computeDeadlines({
      clockStart: MON,
      lawKeys: ["PDPL", "CAN_SPAM"],
      reminderSentAt: at("2026-10-22T10:00:00+03:00"),
    });
    expect(early.escalationOpenAt).toEqual(eod("2026-11-04")); // latest lawful deadline is later than reminder + 7
  });

  it("a notified extension moves latestDueAt and the SDAIA window (PDPL due incl. extension + 90)", () => {
    const r = computeDeadlines({
      clockStart: MON,
      lawKeys: ["PDPL", "CAN_SPAM"],
      extensionNoticeAt: at("2026-10-25T10:00:00+03:00"),
      reminderSentAt: at("2026-11-10T10:00:00+03:00"),
    });
    expect(r.dueAt).toEqual(eod("2026-10-19"));
    expect(r.extendedDueAt).toEqual(eod("2026-12-04"));
    expect(r.latestDueAt).toEqual(eod("2026-12-04"));
    expect(r.escalationOpenAt).toEqual(eod("2026-12-04"));
    expect(r.complaintWindowEndsAt).toEqual(eod("2027-03-04"));
  });

  it("falls back to PDPL 30 days when no tracked law is present (unknown jurisdiction)", () => {
    const r = computeDeadlines({ clockStart: MON, lawKeys: ["UAE_PDPL"] });
    expect(r.dueAt).toEqual(eod("2026-11-04"));
    expect(r.complaintWindowEndsAt).toEqual(eod("2027-02-02"));
  });

  it("has no SDAIA window without PDPL", () => {
    expect(computeDeadlines({ clockStart: MON, lawKeys: ["GDPR"] }).complaintWindowEndsAt).toBeNull();
  });

  it("handles a leap-year GDPR deadline in the full computation", () => {
    const r = computeDeadlines({ clockStart: at("2028-01-31T09:00:00+03:00"), lawKeys: ["PDPL", "GDPR"] });
    expect(r.dueAt).toEqual(eod("2028-02-29"));
    expect(r.latestDueAt).toEqual(eod("2028-03-01")); // PDPL: 31 Jan + 30 days
  });
});
