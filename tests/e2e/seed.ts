/* eslint-disable no-console */
// E2E fixtures for the dev database: 2 mailboxes, 40 companies with evidence (mixed flags and
// confidence), one company without evidence (must never render) and one personal sender.
// Run directly with `npx tsx tests/e2e/seed.ts`, or via Playwright's global setup.
import { PrismaClient, type Confidence } from "@prisma/client";

const NAMES: [string, string][] = [
  ["Noon", "noon.com"], ["مكتبة جرير", "jarir.com"], ["Shein", "shein.com"], ["Careem", "careem.com"],
  ["STC", "stc.com.sa"], ["Amazon", "amazon.sa"], ["Namshi", "namshi.com"], ["Extra", "extra.com"],
  ["Booking.com", "booking.com"], ["Uber", "uber.com"], ["هنقرستيشن", "hungerstation.com"], ["Talabat", "talabat.com"],
  ["IKEA", "ikea.com"], ["Zara", "zara.com"], ["H&M", "hm.com"], ["Nike", "nike.com"],
  ["Adidas", "adidas.com"], ["Spotify", "spotify.com"], ["Netflix", "netflix.com"], ["LinkedIn", "linkedin.com"],
  ["Airbnb", "airbnb.com"], ["Agoda", "agoda.com"], ["Emirates", "emirates.com"], ["Saudia", "saudia.com"],
  ["flynas", "flynas.com"], ["Tamara", "tamara.co"], ["Tabby", "tabby.ai"], ["STC Pay", "stcpay.com.sa"],
  ["Nahdi", "nahdionline.com"], ["Panda", "panda.com.sa"], ["Danube", "danube.sa"], ["Lulu", "luluhypermarket.com"],
  ["Ounass", "ounass.com"], ["Sivvi", "sivvi.com"], ["Max Fashion", "maxfashion.com"], ["Centrepoint", "centrepointstores.com"],
  ["Udemy", "udemy.com"], ["Coursera", "coursera.org"], ["Medium", "medium.com"], ["Noon UAE", "noon.ae"],
];

export const E2E = { companies: NAMES.length, gmail: "you@gmail.com", outlook: "you@outlook.com" };

const confidenceFor = (i: number): Confidence => (i % 4 === 3 ? "LOW" : i % 4 === 1 ? "MEDIUM" : "HIGH");
const DAY = 24 * 3600 * 1000;

export async function seed(db = new PrismaClient()) {
  const url = process.env.DATABASE_URL ?? "";
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) throw new Error("E2E seed refuses to run against a non-local database");
  await db.$transaction([
    db.classification.deleteMany(),
    db.decision.deleteMany(),
    db.companyContact.deleteMany(),
    db.request.deleteMany(),
    db.companyDomain.deleteMany(),
    db.sender.deleteMany(),
    db.company.deleteMany(),
    db.mailAccount.deleteMany(),
    db.setting.deleteMany(),
    db.owner.deleteMany(),
  ]);
  await db.owner.create({ data: { id: "owner", loginEmails: [E2E.gmail, E2E.outlook] } });
  await db.setting.create({ data: { key: "aiMode", value: "RULES" } });

  const now = Date.now();
  const gmail = await db.mailAccount.create({
    data: {
      provider: "GOOGLE", address: E2E.gmail, providerUserId: "e2e-g", grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      tokenCipher: Buffer.from("e2e"), tokenKeyVersion: 1, scanFrom: new Date(now - 3 * 365 * DAY),
      scanProgress: { phase: "done", listed: 1800, fetched: 1800, startedAt: new Date(now - DAY).toISOString() },
    },
  });
  const outlook = await db.mailAccount.create({
    data: {
      provider: "MICROSOFT", address: E2E.outlook, providerUserId: "e2e-m", grantedScopes: ["Mail.Read", "Mail.Send", "offline_access"],
      tokenCipher: Buffer.from("e2e"), tokenKeyVersion: 1, scanFrom: new Date(now - 3 * 365 * DAY),
      scanProgress: { phase: "fetching", listed: 1000, fetched: 400, startedAt: new Date(now - 3600_000).toISOString() },
    },
  });

  for (const [i, [name, domain]] of NAMES.entries()) {
    const ads = i % 3 !== 2;
    const data = i % 3 !== 1;
    const confidence = confidenceFor(i);
    const msgs = 400 - i * 9;
    const company = await db.company.create({ data: { name, primaryDomain: domain, sendsAds: ads, holdsData: data, confidence } });
    await db.companyDomain.create({ data: { domain, companyId: company.id, source: "psl" } });
    const sender = await db.sender.create({
      data: {
        registrableDomain: domain, displayName: name, companyId: company.id, msgCount: msgs,
        marketingCount: ads ? Math.ceil(msgs * 0.8) : 0, transactionalCount: data ? Math.floor(msgs * 0.2) : 0,
        firstSeen: new Date(now - (1000 - i * 10) * DAY), lastSeen: new Date(now - (i * 13) * DAY), hasOneClick: ads,
        exampleSubjects: [
          ...(data ? [`Your ${name} order has shipped`] : []),
          ...(ads ? [`${name}: up to 70% off`] : []),
          `Welcome to ${name}`,
        ],
        accountIds: i % 5 === 0 ? [gmail.id, outlook.id] : i % 2 ? [outlook.id] : [gmail.id],
      },
    });
    const ruleIds = [...(ads ? ["ONE_CLICK", "LIST_UNSUB"] : []), ...(data ? ["TXN_SUBJECT", "NO_LIST_HEADERS"] : [])];
    await db.classification.create({
      data: {
        senderId: sender.id, companyId: company.id, method: "RULES", confidence,
        labels: [...(ads ? ["ads"] : []), ...(data ? ["holds_data"] : [])], ruleIds,
      },
    });
  }

  // No evidence: a company row without senders must never be listed.
  const ghost = await db.company.create({ data: { name: "Ghost Corp", primaryDomain: "ghost-e2e.example", sendsAds: true, confidence: "HIGH" } });
  await db.companyDomain.create({ data: { domain: "ghost-e2e.example", companyId: ghost.id, source: "psl" } });
  // Personal sender: never a company.
  await db.sender.create({
    data: { registrableDomain: "friend@gmail.com", isPersonal: true, msgCount: 12, firstSeen: new Date(now - 100 * DAY), lastSeen: new Date(now - DAY), accountIds: [gmail.id] },
  });
  await db.$disconnect();
}

if (process.argv[1]?.endsWith("seed.ts")) {
  try {
    process.loadEnvFile?.(".env");
  } catch {}
  seed().then(() => console.log(`seeded ${E2E.companies} companies`));
}
