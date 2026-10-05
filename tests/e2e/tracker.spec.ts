import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { expectNoSeriousAxe, reseed } from "./helpers";

test.beforeEach(reseed);

const row = (page: Page, ref: string) => page.locator(`li[data-request="${ref}"]`);

async function withDb<T>(fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  const db = new PrismaClient();
  try {
    return await fn(db);
  } finally {
    await db.$disconnect();
  }
}
const req = (ref: string) => withDb((db) => db.request.findUniqueOrThrow({ where: { reference: ref } }));

test("each row shows a canonical status (icon + text) and exactly one next action", async ({ page }) => {
  await page.goto("/en/tracker");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tracker");
  // Drafts live on /review.
  await expect(row(page, "SD-NOON")).toHaveCount(0);

  const expectations: [string, string, string][] = [
    ["SD-AMZ1", "Sent", "NONE"],
    ["SD-NMS1", "Sent", "CONFIRM_REPLY"],
    ["SD-EXT1", "Needs your reply", "REPLY_WITH_DETAILS"],
    ["SD-UBR1", "Needs your reply", "GRANT_SEND_PERMISSION"],
    ["SD-IKE1", "Overdue", "SEND_REMINDER"],
    ["SD-ZAR1", "Refused", "ESCALATE"],
    ["SD-HM01", "Completed", "VIEW_REPLY"],
    ["SD-NKE1", "Sending", "CANCEL"],
    ["SD-ADI1", "Escalated", "NONE"],
  ];
  for (const [ref, label, next] of expectations) {
    const r = row(page, ref);
    await expect(r.locator("[data-status]")).toHaveText(new RegExp(label));
    await expect(r.locator("[data-next]")).toHaveCount(1);
    await expect(r.locator("[data-next]")).toHaveAttribute("data-next", next);
  }
  await expect(row(page, "SD-AMZ1")).toContainText("Nothing to do — we'll tell you when they reply.");
  await expect(row(page, "SD-AMZ1")).toContainText(/2[67] days left · due/);
  await expect(row(page, "SD-IKE1")).toContainText(/1[01] days past the legal deadline/);
  await expect(row(page, "SD-EXT1")).toContainText("They asked to verify your identity. Only share what's needed.");
  await expect(row(page, "SD-UBR1").getByRole("link", { name: /Allow sending/ })).toHaveAttribute("href", /\/api\/mail\/google\/start\?send=1/);

  // Summary tabs filter via the URL.
  await page.getByRole("link", { name: /^Overdue/ }).click();
  await expect(page).toHaveURL(/tab=overdue/);
  await expect(page.locator("li[data-request]")).toHaveCount(1);
});

test("cancel while queued", async ({ page }) => {
  await page.goto("/en/tracker");
  await row(page, "SD-NKE1").getByRole("button", { name: /Cancel sending/ }).click();
  await expect.poll(async () => (await req("SD-NKE1")).status).toBe("APPROVED");
});

test("reply confirmation updates the status", async ({ page }) => {
  await page.goto("/en/tracker");
  await row(page, "SD-NMS1").getByRole("link", { name: /Check their reply/ }).click();
  const reply = page.locator("li[data-reply]");
  await expect(reply).toContainText("We have deleted your personal data as requested.");
  await expect(reply).toContainText("Looks like: they confirmed it's done");
  await reply.getByRole("button", { name: "Yes, update status" }).click();
  await expect.poll(async () => (await req("SD-NMS1")).status).toBe("COMPLETED");
});

test("ID request: “Reply with details” drafts template 6e for review", async ({ page }) => {
  await page.goto("/en/tracker");
  await row(page, "SD-EXT1").getByRole("button", { name: /Reply with details/ }).click();
  await expect(page).toHaveURL(/\/en\/review\?item=/);
  const editor = page.locator("article[data-outbound]");
  await expect(editor.getByRole("heading", { level: 2 })).toContainText("Extra — Reply to identity request");
  await expect(editor.getByLabel("Letter")).toHaveValue(/confirm control of this address/);
  await expect(editor.locator('[data-pii="nationalId"]')).toHaveAttribute("data-included", "false");
});

test("overdue: “Send reminder” drafts the reminder for review", async ({ page }) => {
  await page.goto("/en/tracker");
  await row(page, "SD-IKE1").getByRole("button", { name: /Send reminder/ }).click();
  await expect(page).toHaveURL(/\/en\/review\?item=/);
  await expect(page.locator("article[data-outbound]").getByRole("heading", { level: 2 })).toContainText("IKEA — Reminder");
});

test("escalation wizard shows the regulator and complaint text and never files anything", async ({ page }) => {
  await page.goto("/en/tracker");
  await row(page, "SD-ZAR1").getByRole("link", { name: /File a complaint with SDAIA/ }).click();
  const dialog = page.getByRole("dialog", { name: "File a complaint yourself" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("complaint-text")).toContainText("SD-ZAR1");
  await expect(dialog.getByRole("link", { name: /Open .* portal/ })).toHaveAttribute("href", /^https:\/\//);
  await expect(dialog.getByRole("button", { name: "Copy complaint text" })).toBeVisible();
  // No control that submits to a regulator: only copy, close and "I filed it".
  const buttons = await dialog.getByRole("button").allInnerTexts();
  expect(buttons.map((b) => b.trim()).filter(Boolean).sort()).toEqual(["Close", "Copy complaint text", "I filed it", "×"].sort());
  await expect(dialog.getByRole("button", { name: /submit|send/i })).toHaveCount(0);
  expect((await req("SD-ZAR1")).status).toBe("REFUSED");

  await dialog.getByLabel("Complaint reference number (optional)").fill("SDAIA-777");
  await dialog.getByRole("button", { name: "I filed it" }).click();
  await expect.poll(async () => (await req("SD-ZAR1")).status).toBe("ESCALATED");
  expect((await req("SD-ZAR1")).complaintRef).toBe("SDAIA-777");
});

test("evidence ZIP downloads for the owner", async ({ page }) => {
  const r = await req("SD-HM01");
  const res = await page.request.get(`/api/requests/${r.id}/evidence`);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toBe("application/zip");
  expect((await res.body()).subarray(0, 2).toString()).toBe("PK");
  expect((await page.request.get("/api/requests/nope/evidence")).status()).toBe(404);
});

for (const locale of ["ar", "en"] as const) {
  test(`axe: /${locale}/tracker and /${locale}/tracker/[id]`, async ({ page }) => {
    await page.goto(`/${locale}/tracker`);
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    await expect(row(page, "SD-AMZ1")).toBeVisible();
    await expectNoSeriousAxe(page);

    const nms = await req("SD-NMS1");
    await page.goto(`/${locale}/tracker/${nms.id}`);
    await expect(page.locator("li[data-reply]")).toBeVisible();
    await expectNoSeriousAxe(page);

    const zr = await req("SD-ZAR1");
    await page.goto(`/${locale}/tracker/${zr.id}?escalate=1`);
    await expect(page.getByTestId("complaint-text")).toBeVisible();
    await expectNoSeriousAxe(page);
  });
}
