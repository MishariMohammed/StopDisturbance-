import { describe, expect, it } from "vitest";
import { diffWords, hasChanges, tokenize } from "@/lib/review/diff";
import { detectIdentifiers, hasPossibleIdNumber } from "@/lib/review/personal-data";
import { channelOf, isApproved, lawSummaryKeys, planSend, secondsLeft } from "@/lib/review/plan";
import { bucketOf, deadlineView, parseTrackerFilters, statusMeta, STATUSES } from "@/lib/tracker-view/view";

describe("diffWords", () => {
  it("returns a single unchanged op for identical text", () => {
    expect(diffWords("Dear team,\nplease delete.", "Dear team,\nplease delete.")).toEqual([{ type: "same", text: "Dear team,\nplease delete." }]);
  });

  it("marks inserted and removed words and keeps the rest", () => {
    const ops = diffWords("Please delete my data now.", "Please erase all my data now.");
    expect(ops).toEqual([
      { type: "same", text: "Please " },
      { type: "del", text: "delete" },
      { type: "add", text: "erase all" },
      { type: "same", text: " my data now." },
    ]);
    expect(hasChanges(ops)).toBe(true);
  });

  it("rebuilds both sides from the ops", () => {
    const a = "سطر أول\nUnder the Saudi PDPL, Art. 18.\nRef SD-AB12";
    const b = "سطر أول معدل\nRef SD-AB12\nThanks";
    const ops = diffWords(a, b);
    expect(ops.filter((o) => o.type !== "add").map((o) => o.text).join("")).toBe(a);
    expect(ops.filter((o) => o.type !== "del").map((o) => o.text).join("")).toBe(b);
  });

  it("treats whitespace-only differences as no change for the UI", () => {
    expect(hasChanges(diffWords("a b", "a  b"))).toBe(false);
    expect(tokenize("a  b\nc")).toEqual(["a", "  ", "b", "\n", "c"]);
  });
});

describe("detectIdentifiers", () => {
  const known = { fullName: "Sara Al-Harbi", emails: ["sara@gmail.com"] };

  it("finds the owner's name and email but no ID by default", () => {
    const r = detectIdentifiers("I, Sara Al-Harbi, use sara@gmail.com. Ref SD-AB12. 30 days.", known);
    expect(r).toEqual({ name: true, email: true, phone: false, account: false, nationalId: false });
  });

  it("flags a Saudi national ID or Iqama, also in Arabic-Indic digits", () => {
    expect(detectIdentifiers("ID 1012345678", known).nationalId).toBe(true);
    expect(detectIdentifiers("إقامة ٢٠١٢٣٤٥٦٧٨", known).nationalId).toBe(true);
    expect(detectIdentifiers("call 0551234567", known).nationalId).toBe(false);
    expect(hasPossibleIdNumber("رقم ١٠١٢٣٤٥٦٧٨")).toBe(true);
    expect(hasPossibleIdNumber("Ref SD-AB12, 2026-10-05")).toBe(false);
  });

  it("finds phone numbers and order/account numbers", () => {
    expect(detectIdentifiers("Mobile: +966 55 123 4567", known).phone).toBe(true);
    expect(detectIdentifiers("Mobile 0551234567", known).phone).toBe(true);
    expect(detectIdentifiers("Order number: NX-88213", known).account).toBe(true);
    expect(detectIdentifiers("رقم الطلب: 7781234", known).account).toBe(true);
    expect(detectIdentifiers("Your order has shipped", known).account).toBe(false);
  });
});

describe("plan helpers", () => {
  it("maps law keys to LawExplainer rows", () => {
    expect(lawSummaryKeys(["PDPL", "CST_ANTISPAM", "GDPR", "CAN_SPAM"], false)).toEqual(["PDPL", "GDPR", "CAN_SPAM"]);
    expect(lawSummaryKeys(["PDPL"], true)).toEqual(["UNKNOWN"]);
    expect(lawSummaryKeys([], false)).toEqual(["UNKNOWN"]);
  });

  it("maps outbound kinds to channels", () => {
    expect(channelOf("INITIAL")).toBe("EMAIL");
    expect(channelOf("REMINDER")).toBe("EMAIL");
    expect(channelOf("ONE_CLICK_POST")).toBe("ONE_CLICK");
    expect(channelOf("UNSUB_MAILTO")).toBe("MAILTO");
    expect(channelOf("WEB_FORM_COPY")).toBe("WEB_FORM");
  });

  it("holds approval only while the hashes match", () => {
    expect(isApproved({ approvedHash: "h1", draftHash: "h1" }, "APPROVED")).toBe(true);
    expect(isApproved({ approvedHash: "h1", draftHash: "h2" }, "APPROVED")).toBe(false);
    expect(isApproved({ approvedHash: null, draftHash: "h1" }, "DRAFT")).toBe(false);
    expect(isApproved({ approvedHash: "h1", draftHash: "h1" }, "DRAFT")).toBe(false);
  });

  it("plans the send: only approved sendable items, grouped by mailbox; web forms listed apart", () => {
    const base = { status: "APPROVED", approved: true, to: "x@y.com" };
    const plan = planSend([
      { ...base, outboundId: "a", kind: "INITIAL", companyName: "Noon", mailbox: "g@gmail.com" },
      { ...base, outboundId: "b", kind: "ONE_CLICK_POST", companyName: "Careem", mailbox: "o@outlook.com" },
      { ...base, outboundId: "c", kind: "INITIAL", companyName: "Jarir", mailbox: "g@gmail.com" },
      { ...base, outboundId: "d", kind: "INITIAL", companyName: "STC", mailbox: "g@gmail.com", approved: false, status: "DRAFT" },
      { ...base, outboundId: "e", kind: "WEB_FORM_COPY", companyName: "Shein", mailbox: "g@gmail.com", approved: false, status: "DRAFT" },
      { ...base, outboundId: "f", kind: "INITIAL", companyName: "Extra", mailbox: "g@gmail.com", status: "QUEUED" },
    ]);
    expect(plan.send.map((i) => i.outboundId)).toEqual(["a", "b", "c"]);
    expect(plan.byMailbox.map((g) => [g.mailbox, g.items.map((i) => i.outboundId)])).toEqual([
      ["g@gmail.com", ["a", "c"]],
      ["o@outlook.com", ["b"]],
    ]);
    expect(plan.webForms.map((i) => i.companyName)).toEqual(["Shein"]);
  });

  it("counts undo seconds down to zero", () => {
    const now = Date.parse("2026-10-05T10:00:00Z");
    expect(secondsLeft("2026-10-05T10:00:10Z", now)).toBe(10);
    expect(secondsLeft(new Date(now + 9_100), now)).toBe(10);
    expect(secondsLeft("2026-10-05T09:59:00Z", now)).toBe(0);
    expect(secondsLeft(null, now)).toBe(0);
  });
});

describe("tracker view", () => {
  const now = new Date("2026-10-05T10:00:00+03:00");

  it("has icon and tone for every canonical status", () => {
    for (const s of STATUSES) {
      expect(statusMeta(s).icon).toBeTruthy();
      expect(statusMeta(s).tone).toBeTruthy();
    }
    expect(statusMeta("OVERDUE")).toEqual({ icon: "⏰", tone: "danger" });
    expect(statusMeta("NEEDS_ACTION").tone).toBe("warning");
  });

  it("maps tracker groups to the summary tabs", () => {
    expect(bucketOf("NEEDS_YOU")).toBe("needs");
    expect(bucketOf("WAITING")).toBe("waiting");
    expect(bucketOf("OVERDUE")).toBe("overdue");
    expect(bucketOf("COMPLETED")).toBe("completed");
    expect(bucketOf("ESCALATED")).toBe("escalated");
    expect(bucketOf("CLOSED")).toBe("closed");
    expect(bucketOf("bogus")).toBe("waiting");
  });

  it("counts days with info / warning / danger steps", () => {
    expect(deadlineView("2026-11-02T23:59:59+03:00", now, "2026-10-03T10:00:00+03:00")).toMatchObject({ days: 29, overdue: false, tone: "info" });
    expect(deadlineView("2026-10-12T09:00:00+03:00", now)).toMatchObject({ days: 7, tone: "warning" });
    const over = deadlineView("2026-10-01T23:59:59+03:00", now);
    expect(over).toMatchObject({ days: -4, overdue: true, tone: "danger", elapsed: 1 });
    const half = deadlineView("2026-10-15T10:00:00+03:00", now, "2026-09-25T10:00:00+03:00");
    expect(half.elapsed).toBeCloseTo(0.5, 5);
  });

  it("parses URL filters with safe defaults", () => {
    expect(parseTrackerFilters({})).toEqual({ tab: "all", q: "", sort: "deadline" });
    expect(parseTrackerFilters({ tab: "needs", q: "  noon ", sort: "company" })).toEqual({ tab: "needs", q: "noon", sort: "company" });
    expect(parseTrackerFilters({ tab: "bogus", sort: ["recent", "x"] })).toEqual({ tab: "all", q: "", sort: "recent" });
  });
});
