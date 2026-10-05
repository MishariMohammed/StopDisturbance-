import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import { gotoReady, reseed } from "./helpers";
import { E2E } from "./seed";

test.beforeEach(reseed);

test("/scan shows per-account progress and refreshes itself", async ({ page }) => {
  await gotoReady(page, "/en/scan");
  const bars = page.getByRole("progressbar");
  await expect(bars).toHaveCount(2);
  await expect(bars.nth(0)).toHaveAttribute("aria-valuenow", "100");
  await expect(bars.nth(1)).toHaveAttribute("aria-valuenow", "40");
  await expect(page.getByText("Companies: 40")).toBeVisible();
  await expect(page.getByRole("link", { name: "See results so far" })).toBeVisible();

  const db = new PrismaClient();
  await db.mailAccount.update({
    where: { address: E2E.outlook },
    data: { scanProgress: { phase: "fetching", listed: 1000, fetched: 900, startedAt: new Date().toISOString() } },
  });
  await db.$disconnect();
  await expect(bars.nth(1)).toHaveAttribute("aria-valuenow", "90", { timeout: 15_000 });

  const res = await page.request.get("/api/scan/status");
  expect(res.ok()).toBe(true);
  expect((await res.json()).companies).toBe(40);
});

test("/connect first-run setup saves owner details with AI default Rules only", async ({ page }) => {
  await gotoReady(page, "/en/connect");
  await expect(page.getByRole("radio", { name: /^Rules only/ })).toBeChecked();
  await expect(page.getByRole("radio", { name: /^DeepSeek/ })).toBeDisabled();
  await page.getByLabel("Your name as companies know you").fill("Mishari Test");
  await page.getByLabel("Country you live in").selectOption("SA");
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.getByText("Saved. Next, connect a mailbox.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "First-run setup" })).toHaveCount(0);

  // Google connect goes through the unverified-app interstitial.
  await page.getByRole("button", { name: "Connect Gmail" }).click();
  const dialog = page.getByRole("dialog", { name: "Heads up: Google will show a warning" });
  await expect(dialog.getByRole("link", { name: "Continue to Google" })).toHaveAttribute("href", /\/api\/mail\/google\/start/);
  await dialog.getByRole("button", { name: "Not now" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Limited access")).toBeVisible();
});
