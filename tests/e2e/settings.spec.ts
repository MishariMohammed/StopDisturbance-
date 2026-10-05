import { expect, test } from "@playwright/test";
import { expectNoSeriousAxe, gotoReady, reseed } from "./helpers";

// /settings and /settings/data (04-ux §3.6, 00-brief §9 M6). Runs serially; erase goes last and the
// database is reseeded afterwards.

test.describe.configure({ mode: "serial" });
test.beforeAll(reseed);
test.afterAll(reseed);

for (const locale of ["ar", "en"] as const) {
  for (const path of ["settings", "settings/data"] as const) {
    test(`axe: /${locale}/${path} has no serious or critical issues`, async ({ page }) => {
      await gotoReady(page, `/${locale}/${path}`);
      await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
      await expect(page.locator("h1")).toBeVisible();
      await expectNoSeriousAxe(page);
    });
  }

  test(`axe: /${locale}/settings with the disconnect confirmation and AI log values open`, async ({ page }) => {
    await gotoReady(page, `/${locale}/settings?reveal=1`);
    await page.locator('li[data-mailbox="you@gmail.com"] summary').click();
    await expectNoSeriousAxe(page);
  });
}

test("/settings lists mailboxes with status, send permission and last refreshed", async ({ page }) => {
  await gotoReady(page, "/en/settings");
  const mailboxes = page.locator("#mailboxes");
  const gmail = mailboxes.locator('li[data-mailbox="you@gmail.com"]');
  await expect(gmail).toContainText("Connected");
  await expect(gmail).toContainText("No send permission");
  await expect(gmail).toContainText("Gmail token:");
  await expect(gmail.getByRole("link", { name: /Reconnect/ })).toHaveAttribute("href", /\/api\/mail\/google\/start\?locale=en&hint=you%40gmail\.com/);
  const outlook = mailboxes.locator('li[data-mailbox="you@outlook.com"]');
  await expect(outlook).toContainText("Read headers · Send");
  await expect(outlook.getByRole("link", { name: /Reconnect/ })).toHaveAttribute("href", /\/api\/mail\/microsoft\/start\?locale=en&send=1/);
});

test("/settings: DeepSeek stays locked until Test connection passes", async ({ page }) => {
  await gotoReady(page, "/en/settings");
  await expect(page.getByRole("radio", { name: /^DeepSeek/ })).toBeDisabled();
  await page.getByRole("button", { name: "Test connection" }).click();
  // No reachable DeepSeek in the test environment: the test fails (or there is no key) and DeepSeek stays locked.
  await expect(page.getByRole("alert").filter({ hasText: /connection test failed|No API key/ })).toBeVisible();
  await expect(page.getByRole("radio", { name: /^DeepSeek/ })).toBeDisabled();
  await expect(page.getByText("Current mode:")).toContainText("Rules only");
});

test("/settings: reply AI needs its own acknowledgement and is off by default", async ({ page }) => {
  await gotoReady(page, "/en/settings");
  const section = page.locator("#reply-ai");
  await expect(section).toContainText("Off (default)");
  await section.getByLabel("Use AI to suggest what a company's reply means").check();
  await section.getByRole("button", { name: "Save reply setting" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "tick the acknowledgement" })).toBeVisible();
  await expect(page.locator("#reply-ai")).toContainText("Off (default)");
});

test("/settings: notifications and retention years are saved", async ({ page }) => {
  await gotoReady(page, "/en/settings");
  await page.getByLabel("Weekly digest (Sunday 09:00)").uncheck();
  await page.getByRole("button", { name: "Save notifications" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Notification settings saved." })).toBeVisible();
  await expect(page.getByLabel("Weekly digest (Sunday 09:00)")).not.toBeChecked();
  await expect(page.getByLabel("A company replied")).toBeChecked();

  await page.getByLabel("Keep closed requests for").selectOption("2");
  await page.locator("#retention").getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#retention").getByRole("status")).toBeVisible();
  await expect(page.getByLabel("Keep closed requests for")).toHaveValue("2");
});

test("/settings/data: JSON export is owner-only and has no tokens or ciphertexts", async ({ page, request }) => {
  await gotoReady(page, "/en/settings/data");
  await expect(page.getByRole("link", { name: "Download my data (JSON)" })).toHaveAttribute("href", "/api/data/export");
  const res = await request.get("/api/data/export");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-disposition"]).toMatch(/attachment; filename="stopdisturbance-export-/);
  const text = await res.text();
  const data = JSON.parse(text);
  expect(data.format).toBe("stopdisturbance-export/1");
  expect(data.mailboxes.map((m: { address: string }) => m.address).sort()).toEqual(["you@gmail.com", "you@outlook.com"]);
  expect(text).not.toMatch(/tokenCipher|Cipher"|bodyCipher|payloadCipher|refresh_token|access_token/);
});

test("/settings: disconnecting a mailbox needs confirmation", async ({ page }) => {
  await gotoReady(page, "/en/settings");
  const gmail = page.locator('li[data-mailbox="you@gmail.com"]');
  await gmail.locator("summary").click();
  await gmail.getByLabel("Yes, disconnect this mailbox").check();
  await gmail.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Mailbox disconnected" })).toBeVisible();
  await expect(page.locator('li[data-mailbox="you@gmail.com"]')).toContainText("Disconnected");
});

test("/en/settings/data: erase needs the typed word ERASE, also on the server", async ({ page }) => {
  await gotoReady(page, "/en/settings/data");
  const input = page.getByLabel("Type ERASE to confirm");
  const button = page.getByRole("button", { name: "Erase everything" });
  await expect(button).toBeDisabled();
  await input.fill("ERAS");
  await expect(button).toBeDisabled();
  await input.fill("امسح");
  await expect(button).toBeDisabled();
  // Bypass the client check: the server refuses too.
  await button.evaluate((b) => b.removeAttribute("disabled"));
  await button.click();
  await expect(page.getByRole("alert").filter({ hasText: "Not erased" })).toBeVisible();
  await gotoReady(page, "/en/settings/data");
  await expect(page.locator("#stored")).toContainText(/[1-9]\d* companies/);
});

test("/ar/settings/data: typing امسح erases everything and shows the Microsoft consent link", async ({ page }) => {
  await gotoReady(page, "/ar/settings/data");
  const button = page.getByRole("button", { name: "امسح كل شيء" });
  await page.getByLabel("اكتب امسح للتأكيد").fill("ERASE");
  await expect(button).toBeDisabled();
  await page.getByLabel("اكتب امسح للتأكيد").fill("امسح");
  await expect(button).toBeEnabled();
  await button.click();
  const done = page.getByTestId("erase-done");
  await expect(done).toContainText("تم مسح كل شيء.");
  await expect(done.getByRole("link", { name: /account\.live\.com/ })).toHaveAttribute("href", "https://account.live.com/consent/Manage");
  await gotoReady(page, "/ar/settings/data");
  await expect(page.locator("#stored")).toContainText("0 شركة");
});
