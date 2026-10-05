import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { expectNoSeriousAxe, gotoReady, reseed } from "./helpers";

test.beforeEach(reseed);

const queue = (page: Page) => page.getByRole("navigation", { name: "Queue" });
const editor = (page: Page) => page.locator("article[data-outbound]");

async function withDb<T>(fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  const db = new PrismaClient();
  try {
    return await fn(db);
  } finally {
    await db.$disconnect();
  }
}

const statusOf = (ref: string) => withDb((db) => db.request.findUniqueOrThrow({ where: { reference: ref } }).then((r) => r.status));

test("list view approves per row only; there is no approve-all", async ({ page }) => {
  await gotoReady(page, "/en/review?view=list");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Review and approve");
  await expect(page.getByText("4 drafts · 0 approved · 4 to review")).toBeVisible();
  await expect(page.getByRole("button", { name: /approve all/i })).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: /approve all/i })).toHaveCount(0);
  const rows = page.getByRole("checkbox", { name: /^Approve / });
  await expect(rows).toHaveCount(3); // Noon, Jarir, Careem — the web form is submitted by the owner
  await expect(page.getByRole("link", { name: "Submit it yourself" })).toBeVisible();

  await page.getByRole("checkbox", { name: "Approve Noon" }).check();
  await expect(page.getByText("1 approved", { exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Approve مكتبة جرير" })).not.toBeChecked();
  await expect.poll(() => statusOf("SD-NN01")).toBe("APPROVED");
  expect(await statusOf("SD-JRR1")).toBe("DRAFT");

  // Expanding a row shows the full text.
  await page.getByRole("button", { name: /Noon — show text/ }).click();
  await expect(page.getByText("Under the Saudi Personal Data Protection Law").first()).toBeVisible();

  // Unticking clears that row's approval.
  await page.getByRole("checkbox", { name: "Approve Noon" }).uncheck();
  await expect(page.getByText("0 approved", { exact: true })).toBeVisible();
  await expect.poll(() => statusOf("SD-NN01")).toBe("DRAFT");
});

test("editing after approval clears the approval; guardrails and diff", async ({ page }) => {
  await gotoReady(page, "/en/review");
  await queue(page).getByRole("button", { name: /Noon/ }).click();
  await expect(editor(page).getByRole("heading", { level: 2 })).toContainText("Noon — Remove my data");
  await expect(editor(page)).toContainText("Email from you@gmail.com");
  await expect(editor(page).getByText("This mailbox hasn't allowed sending yet.")).toBeVisible();
  await expect(editor(page).getByRole("link", { name: "Allow sending" })).toHaveAttribute("href", /\/api\/mail\/google\/start\?send=1/);
  await expect(editor(page).locator('[data-pii="name"]')).toHaveAttribute("data-included", "true");
  await expect(editor(page).locator('[data-pii="nationalId"]')).toHaveAttribute("data-included", "false");

  await editor(page).getByRole("button", { name: "Approve" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Noon: approved." })).toBeVisible();
  await queue(page).getByRole("button", { name: /Noon/ }).click();
  await expect(editor(page).getByText("Approved. Editing the letter clears the approval.")).toBeVisible();
  expect(await statusOf("SD-NN01")).toBe("APPROVED");

  const body = editor(page).getByRole("textbox", { name: "Letter" });
  const text = await body.inputValue();
  await body.fill(text.replace(/Under the Saudi Personal Data Protection Law \(Royal Decree M\/19\), Arts\. 4, 5 and 18, /, "") + "\nMy ID is 1012345678.\n");
  // Client-side guardrail before saving.
  await expect(editor(page).locator('[data-warning="possible_id_number"]')).toBeVisible();
  await expect(editor(page).locator('[data-pii="nationalId"]')).toHaveAttribute("data-included", "true");
  await editor(page).getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Your edit cleared the approval" })).toBeVisible();
  await expect(editor(page).locator('[data-warning="citation_removed"]')).toBeVisible();
  await expect(editor(page).getByRole("button", { name: "Approve" })).toBeVisible();
  expect(await statusOf("SD-NN01")).toBe("DRAFT");
  const out = await withDb((db) => db.request.findUniqueOrThrow({ where: { reference: "SD-NN01" } }).then((r) => db.outboundMessage.findFirstOrThrow({ where: { requestId: r.id } })));
  expect(out.approvedHash).toBeNull();

  // Diff against the generated text, with text labels (not colour alone).
  await editor(page).getByRole("button", { name: "Show changes from template" }).click();
  await expect(editor(page).locator("ins").filter({ hasText: "1012345678" })).toContainText("Added");
  await expect(editor(page).locator("del").filter({ hasText: "Personal Data Protection Law" })).toContainText("Removed");

  // Reset restores the original.
  await editor(page).getByRole("button", { name: "Reset to original" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Restored the original text." })).toBeVisible();
  await expect(editor(page).getByRole("textbox", { name: "Letter" })).toHaveValue(text);
});

test("the recipient can be changed (e.g. to the owner's own address); a bad address is refused; the edit clears approval", async ({ page }) => {
  await gotoReady(page, "/en/review");
  await queue(page).getByRole("button", { name: /Noon/ }).click();
  await editor(page).getByRole("button", { name: "Approve" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Noon: approved." })).toBeVisible();
  await queue(page).getByRole("button", { name: /Noon/ }).click();
  const to = editor(page).getByRole("textbox", { name: "To" });
  await expect(to).toHaveValue("privacy@noon.com");

  await to.fill("me at example");
  await expect(to).toHaveAttribute("aria-invalid", "true");
  await expect(to).toHaveAccessibleDescription(/Enter one email address/);
  await expect(editor(page).getByRole("button", { name: "Save changes" })).toBeDisabled();
  await expect(editor(page).getByRole("button", { name: "Approve" })).toBeDisabled();

  await to.fill("you@gmail.com");
  await expect(to).not.toHaveAttribute("aria-invalid", "true");
  await expect(editor(page).locator("[data-recipient-changed]")).toContainText("privacy@noon.com");
  await editor(page).getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Your edit cleared the approval" })).toBeVisible();
  const out = await withDb((db) =>
    db.request.findUniqueOrThrow({ where: { reference: "SD-NN01" } }).then((r) => db.outboundMessage.findFirstOrThrow({ where: { requestId: r.id } })),
  );
  expect(out.toAddress).toBe("you@gmail.com");
  expect(out.approvedHash).toBeNull();
  expect(await statusOf("SD-NN01")).toBe("DRAFT");

  // Approve again; the send dialog names the new recipient.
  await editor(page).getByRole("button", { name: "Approve" }).click();
  await expect.poll(() => statusOf("SD-NN01")).toBe("APPROVED");
  await page.getByRole("button", { name: "Send 1 approved requests…" }).click();
  await expect(page.getByRole("dialog", { name: "Send 1 requests?" })).toContainText("Noon — Remove my data — you@gmail.com");
});

test("send confirmation names the count, mailbox and every recipient; undo cancels", async ({ page }) => {
  await gotoReady(page, "/en/review?view=list");
  for (const name of ["Noon", "مكتبة جرير", "Careem"]) {
    await page.getByRole("checkbox", { name: `Approve ${name}` }).check();
    await expect(page.getByRole("checkbox", { name: `Approve ${name}` })).toBeChecked();
  }
  await page.getByRole("button", { name: "Send 3 approved requests…" }).click();
  const dialog = page.getByRole("dialog", { name: "Send 3 requests?" });
  await expect(dialog).toContainText("From: you@gmail.com");
  await expect(dialog).toContainText("From: you@outlook.com");
  await expect(dialog).toContainText("Noon — Remove my data — privacy@noon.com");
  await expect(dialog).toContainText("مكتبة جرير — Remove my data — dpo@jarir.com");
  await expect(dialog).toContainText("Careem — Unsubscribe (one-click) — one-click unsubscribe");
  await expect(dialog).toContainText("+ 1 web forms you'll submit yourself (Shein)");
  await expect(dialog).toContainText("Once sent, they can't be recalled.");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await expect(dialog.getByRole("button", { name: "Send 3 requests" })).toBeVisible();

  await dialog.getByRole("button", { name: "Send 3 requests" }).click();
  await expect(page.getByRole("status").filter({ hasText: /Sending 3 requests in \d+s|Paused/ })).toBeVisible();
  await expect.poll(() => statusOf("SD-NN01")).toBe("QUEUED");
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Sending stopped for 3 requests" })).toBeVisible();
  for (const ref of ["SD-NN01", "SD-JRR1", "SD-CRM1"]) await expect.poll(() => statusOf(ref)).toBe("APPROVED");
});

test("web form: copy block and “I submitted it” starts the clock", async ({ page }) => {
  await gotoReady(page, "/en/review");
  await queue(page).getByRole("button", { name: /Shein/ }).click();
  const guide = editor(page).getByRole("region", { name: "Submit their web form yourself" });
  await expect(guide.getByRole("link", { name: /Open form/ })).toHaveAttribute("href", "https://shein.example/privacy-request");
  await expect(guide.getByRole("button", { name: "Copy Request text" })).toBeVisible();
  await expect(guide.getByRole("button", { name: "Copy Name" })).toBeVisible();
  await expect(editor(page).getByRole("button", { name: "Approve" })).toHaveCount(0);
  await guide.getByLabel("Date you submitted it").fill("2026-10-01");
  await guide.getByRole("button", { name: "I submitted it" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Shein: submission recorded." })).toBeVisible();
  const req = await withDb((db) => db.request.findUniqueOrThrow({ where: { reference: "SD-SHN1" } }));
  expect(req.status).toBe("SENT");
  expect(req.clockStart?.toISOString().slice(0, 10)).toBe("2026-10-01");
});

test("companies: “Create N drafts” for decided companies opens /review", async ({ page }) => {
  await gotoReady(page, "/en/companies");
  await expect(page.getByRole("button", { name: /^Create \d+ drafts$/ })).toHaveCount(0);
  await page.locator('li[data-company="udemy.com"]').getByText("Remove my data", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Create 1 drafts" })).toBeVisible();
  await page.getByRole("button", { name: "Create 1 drafts" }).click();
  await expect(page).toHaveURL(/\/en\/review\?created=1/);
  await expect(page.getByText("Created drafts for 1 companies.")).toBeVisible();
  await expect(queue(page).getByRole("button", { name: /Udemy/ })).toBeVisible();
});

for (const locale of ["ar", "en"] as const) {
  test(`axe: /${locale}/review (one by one, list, confirm dialog)`, async ({ page }) => {
    await gotoReady(page, `/${locale}/review`);
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    await expect(editor(page)).toBeVisible();
    await expectNoSeriousAxe(page);
    await gotoReady(page, `/${locale}/review?view=list`);
    await expect(page.locator("table")).toBeVisible();
    await page.locator("table input[type=checkbox]").first().check();
    await expect(page.locator("table input[type=checkbox]").first()).toBeChecked();
    await expectNoSeriousAxe(page);
    await page.getByRole("button", { name: locale === "ar" ? /إرسال 1 طلبات معتمدة/ : "Send 1 approved requests…" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expectNoSeriousAxe(page);
  });
}
