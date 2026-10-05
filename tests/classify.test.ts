import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { classifyProfile, classifySenders, messageRules, refreshCompanyFlags, type RuleId, type SenderProfile } from "@/lib/scan/classify";
import { resolvePending } from "@/lib/scan/resolve";
import { RESOLVE_FIXTURES } from "./fixtures/resolve-headers";
import { resetDb } from "./helpers";
import { seedFixtureHeaders, seedOwnerAndAccount, toSignals } from "./scan-helpers";

const profile = (signals: RuleId[], extra: Partial<SenderProfile> = {}): SenderProfile => ({
  isPersonal: false, marketingCount: 0, transactionalCount: 0, hasOneClick: false,
  signals: new Set(signals), headerCount: 1, fuzzyBrand: false, ...extra,
});

describe("rules classifier (pure)", () => {
  const pinned = RESOLVE_FIXTURES.filter((f) => f.rules && f.expected !== "personal");

  it.each(pinned.map((f) => [f.name, f] as const))("%s", (_name, f) => {
    const r = classifyProfile(profile(messageRules(toSignals(f))));
    expect(r.labels).toEqual(f.rules!.labels);
    if (f.rules!.settled === false) expect(r.settled).toBe(false);
  });

  it("confidence follows 04-ux §5.5: 3+ signals High, 2 Medium, 1 Low", () => {
    expect(classifyProfile(profile(["ONE_CLICK", "LIST_UNSUB", "GMAIL_PROMOTIONS"])).confidence).toBe("HIGH");
    expect(classifyProfile(profile(["LIST_UNSUB", "LIST_ID"])).confidence).toBe("MEDIUM");
    expect(classifyProfile(profile(["TXN_SUBJECT"])).confidence).toBe("LOW");
    expect(classifyProfile(profile(["TXN_SUBJECT", "NO_LIST_HEADERS"])).confidence).toBe("MEDIUM");
  });

  it("a fuzzy (display-name) brand match is always Low", () => {
    const r = classifyProfile(profile(["ONE_CLICK", "LIST_UNSUB", "GMAIL_PROMOTIONS"], { fuzzyBrand: true }));
    expect(r).toMatchObject({ labels: ["ads"], confidence: "LOW" });
  });

  it("weak signals alone leave a sender unsettled", () => {
    const r = classifyProfile(profile(["OUTLOOK_OTHER", "NO_LIST_HEADERS"]));
    expect(r).toMatchObject({ settled: false, labels: [], confidence: "LOW" });
    expect(r.ruleIds).toContain("UNSETTLED");
  });

  it("personal senders get the personal label", () => {
    expect(classifyProfile(profile([], { isPersonal: true }))).toMatchObject({ labels: ["personal"], settled: true });
  });

  it("falls back to stored counts once headers are purged", () => {
    const r = classifyProfile(profile([], { headerCount: 0, marketingCount: 4, transactionalCount: 1, hasOneClick: true }));
    expect(r.labels).toEqual(["ads", "holds_data"]);
    expect(r.ruleIds).toEqual(expect.arrayContaining(["ONE_CLICK", "AGG_MARKETING", "AGG_TRANSACTIONAL"]));
  });

  it("Feedback-ID on an SES receipt is not an ad signal", () => {
    const amazon = RESOLVE_FIXTURES.find((f) => f.name === "Amazon order via amazon.com")!;
    expect(messageRules(toSignals(amazon))).not.toContain("FEEDBACK_ID");
  });
});

describe("classifySenders (DB)", () => {
  beforeEach(resetDb);

  async function setup() {
    const acc = await seedOwnerAndAccount();
    await seedFixtureHeaders(acc.id);
    const { senderIds } = await resolvePending();
    return senderIds;
  }

  it("writes RULES classifications and company flags", async () => {
    await setup();
    const res = await classifySenders();
    expect(res.unsettled).toBeGreaterThanOrEqual(1);

    const noon = await db.company.findUniqueOrThrow({ where: { primaryDomain: "noon.com" } });
    expect(noon).toMatchObject({ sendsAds: true, holdsData: true, confidence: "HIGH" });
    expect(await db.company.findUniqueOrThrow({ where: { primaryDomain: "careem.com" } })).toMatchObject({ sendsAds: false, holdsData: true });
    // Display-name-only brand evidence keeps the Klaviyo mail from raising confidence; namshi.com has direct evidence too.
    expect((await db.company.findUniqueOrThrow({ where: { primaryDomain: "namshi.com" } })).sendsAds).toBe(true);

    const albaik = await db.sender.findUniqueOrThrow({ where: { registrableDomain: "albaik.com" } });
    const c = await db.classification.findFirstOrThrow({ where: { senderId: albaik.id } });
    expect(c).toMatchObject({ method: "RULES", labels: [], confidence: "LOW" });
    expect(c.ruleIds).toContain("UNSETTLED");

    const gmail = await db.sender.findUniqueOrThrow({ where: { registrableDomain: "gmail.com" } });
    expect((await db.classification.findFirstOrThrow({ where: { senderId: gmail.id } })).labels).toEqual(["personal"]);

    // Re-running replaces, not duplicates, the RULES rows.
    await classifySenders();
    expect(await db.classification.count({ where: { senderId: albaik.id, method: "RULES" } })).toBe(1);
  });

  it("never overrides a MANUAL classification", async () => {
    await setup();
    const noon = await db.company.findUniqueOrThrow({ where: { primaryDomain: "noon.com" } });
    await db.company.update({ where: { id: noon.id }, data: { sendsAds: false, holdsData: false, confidence: "LOW" } });
    await db.classification.create({ data: { companyId: noon.id, method: "MANUAL", labels: [], ruleIds: ["OWNER"], confidence: "HIGH" } });
    await classifySenders();
    await refreshCompanyFlags(noon.id);
    expect(await db.company.findUniqueOrThrow({ where: { id: noon.id } })).toMatchObject({ sendsAds: false, holdsData: false });
  });
});
