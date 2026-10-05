import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { gotoReady, reseed } from "./helpers";

// Visual baselines for the three main screens in both locales (04-ux §11). The seed is fixed except for
// dates, which it sets relative to now: everything marked [data-volatile] (dates, countdowns, deadline
// bars) is replaced with a fixed placeholder so layout doesn't shift, and masked as well.
// Baselines: tests/e2e/__screenshots__ (snapshotPathTemplate in playwright.config.ts). Update with
// `npx playwright test tests/e2e/visual.spec.ts --update-snapshots` after an intended UI change.

test.beforeAll(reseed);
test.use({ viewport: { width: 1280, height: 900 } });

async function freezeVolatile(page: Page) {
  await page.locator("[data-volatile]").evaluateAll((els) => {
    for (const el of els) el.textContent = "00 ••• 0000";
  });
}

async function snap(page: Page, name: string) {
  await freezeVolatile(page);
  // Nothing should have focus or a hover state in the baseline.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(0, 0);
  await expect(page).toHaveScreenshot(`${name}.png`, {
    fullPage: true,
    mask: [page.locator("[data-volatile]")],
    animations: "disabled",
    stylePath: path.join(import.meta.dirname, "visual.css"),
    maxDiffPixelRatio: 0.002,
  });
}

for (const locale of ["ar", "en"] as const) {
  test(`visual: /${locale}/companies`, async ({ page }) => {
    await gotoReady(page, `/${locale}/companies`);
    await expect(page.locator("li[data-company]")).toHaveCount(40);
    await snap(page, `companies-${locale}`);
  });

  test(`visual: /${locale}/review (one by one and list)`, async ({ page }) => {
    await gotoReady(page, `/${locale}/review`);
    await expect(page.locator("article[data-outbound]")).toBeVisible();
    await snap(page, `review-${locale}`);
    await gotoReady(page, `/${locale}/review?view=list`);
    await expect(page.locator("table")).toBeVisible();
    await snap(page, `review-list-${locale}`);
  });

  test(`visual: /${locale}/tracker`, async ({ page }) => {
    await gotoReady(page, `/${locale}/tracker`);
    await expect(page.locator("li[data-request]").first()).toBeVisible();
    await snap(page, `tracker-${locale}`);
  });
}
