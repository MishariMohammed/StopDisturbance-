import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import { gotoReady, messages, reseed, tabTo } from "./helpers";

// 04-ux §10: the whole first journey works with the keyboard alone, in both languages. No clicks, no
// .check()/.fill(): every control is reached with Tab / Shift+Tab and operated with keys.

test.beforeEach(reseed);

async function withDb<T>(fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  const db = new PrismaClient();
  try {
    return await fn(db);
  } finally {
    await db.$disconnect();
  }
}

const fmt = (s: string, vars: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k]));
/** A message as a regex source: literal text, given placeholders filled in, any other placeholder matches anything. */
const pattern = (s: string, vars: Record<string, string>) =>
  s
    .split(/(\{\w+\})/)
    .map((part) => {
      const k = /^\{(\w+)\}$/.exec(part)?.[1];
      if (!k) return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return k in vars ? vars[k] : ".+?";
    })
    .join("");

for (const locale of ["ar", "en"] as const) {
  test(`keyboard-only journey (${locale}): setup → companies → Remove → drafts → approve → send → tracker`, async ({ page }) => {
    const m = messages(locale);
    const name = locale === "ar" ? "سارة الاختبار" : "Sara Keyboard";

    // 1. First-run setup on /connect.
    await gotoReady(page, `/${locale}/connect`);
    await expect(page.getByRole("heading", { name: m.connect.setup.title })).toBeVisible();
    const nameField = page.getByLabel(m.connect.setup.name);
    await tabTo(page, nameField);
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Backspace");
    await page.keyboard.insertText(name);
    await expect(nameField).toHaveValue(name);
    await expect(page.getByLabel(m.connect.setup.country)).toHaveValue("SA");
    await tabTo(page, page.getByRole("button", { name: m.connect.setup.save }));
    await page.keyboard.press("Enter");
    await expect(page.getByText(m.connect.setup.saved)).toBeVisible();
    await expect(page.getByRole("heading", { name: m.connect.setup.title })).toHaveCount(0);
    expect(await withDb((db) => db.owner.findUniqueOrThrow({ where: { id: "owner" } }).then((o) => o.fullName))).toBe(name);

    // 2. The seeded mailboxes are connected.
    await expect(page.getByText("you@gmail.com").first()).toBeVisible();
    await expect(page.getByText("you@outlook.com").first()).toBeVisible();

    // 3. Companies, via the main navigation.
    await tabTo(page, page.getByRole("navigation", { name: m.nav.label }).getByRole("link", { name: m.nav.companies }));
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/${locale}/companies$`));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(fmt(m.companies.title, { count: 40 }));

    // Narrow the list with the search box, then choose Remove with the arrow keys.
    const search = page.getByLabel(m.companies.filters.search);
    await tabTo(page, search);
    await page.keyboard.type("udemy");
    await expect(page).toHaveURL(/q=udemy/);
    const udemy = page.locator('li[data-company="udemy.com"]');
    await expect(page.locator("li[data-company]")).toHaveCount(1);
    const radio = (v: "KEEP" | "UNSUBSCRIBE" | "REMOVE") => udemy.getByRole("radio", { name: m.companies.decision[v], exact: true });
    await tabTo(page, udemy.getByRole("radio"));
    await expect(radio("KEEP")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(radio("UNSUBSCRIBE")).toBeChecked();
    await page.keyboard.press("ArrowDown");
    await expect(radio("REMOVE")).toBeChecked();
    await expect(radio("REMOVE")).toBeFocused();

    // 4. "Create 1 drafts" sits above the list: Shift+Tab back to it.
    const create = page.getByRole("button", { name: fmt(m.companies.drafts.create, { count: 1 }) });
    await expect(create).toBeVisible();
    await tabTo(page, create, { back: true });
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/${locale}/review\\?created=1`));
    await expect(page.getByText(fmt(m.review.created, { count: 1 }))).toBeVisible();

    // 5. Review: open Udemy's draft from the queue and approve it.
    const queueItem = page.getByRole("navigation", { name: m.review.queue }).getByRole("button", { name: /Udemy/ });
    await tabTo(page, queueItem);
    await page.keyboard.press("Enter");
    const editor = page.locator("article[data-outbound]");
    await expect(editor.getByRole("heading", { level: 2 })).toContainText(`Udemy — ${m.review.type.ERASURE_OBJECTION}`);
    await tabTo(page, editor.getByRole("button", { name: m.review.approve, exact: true }));
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status").filter({ hasText: fmt(m.review.approvedOne, { name: "Udemy" }) })).toBeVisible();

    // 6. Send dialog: Cancel has focus first; Tab to the send button and confirm.
    const sendCta = page.getByRole("button", { name: fmt(m.review.sendCta, { count: 1 }) });
    await expect(sendCta).toBeEnabled();
    await tabTo(page, sendCta);
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: fmt(m.review.confirm.title, { count: 1 }) });
    await expect(dialog).toContainText("privacy@udemy.com");
    await expect(dialog.getByRole("button", { name: m.review.confirm.cancel })).toBeFocused();
    await tabTo(page, dialog.getByRole("button", { name: fmt(m.review.confirm.ok, { count: 1 }) }));
    await page.keyboard.press("Enter");

    // 7. The undo toast is up and the request is queued.
    await expect(page.getByRole("button", { name: m.review.toast.undo })).toBeVisible();
    const toastText = new RegExp(`${pattern(m.review.toast.sending, { count: "1" })}|${pattern(m.review.toast.paused, { count: "1" })}`);
    await expect(page.getByRole("status").filter({ hasText: toastText })).toBeVisible();
    const udemyReq = () =>
      withDb((db) => db.companyDomain.findUniqueOrThrow({ where: { domain: "udemy.com" } }).then((d) => db.request.findFirstOrThrow({ where: { companyId: d.companyId }, orderBy: { createdAt: "desc" } })));
    await expect.poll(async () => (await udemyReq()).status).toBe("QUEUED");

    // 8. Tracker (main navigation) shows it as QUEUED ("Sending").
    await tabTo(page, page.getByRole("navigation", { name: m.nav.label }).getByRole("link", { name: m.nav.tracker }), { back: true });
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/${locale}/tracker`));
    const ref = (await udemyReq()).reference;
    const row = page.locator(`li[data-request="${ref}"]`);
    await expect(row.locator("[data-status]")).toHaveAttribute("data-status", "QUEUED");
    await expect(row.locator("[data-status]")).toContainText(m.tracker.status.QUEUED);
  });
}
