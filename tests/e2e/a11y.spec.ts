import { expect, test } from "@playwright/test";
import { expectNoSeriousAxe, gotoReady, reseed } from "./helpers";

test.beforeAll(reseed);

for (const locale of ["ar", "en"] as const) {
  for (const path of ["connect", "scan", "companies", "settings"] as const) {
    test(`axe: /${locale}/${path} has no serious or critical issues`, async ({ page }) => {
      await gotoReady(page, `/${locale}/${path}`);
      await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
      await expect(page.locator("h1")).toBeVisible();
      await expect(page.getByRole("link", { name: locale === "ar" ? "ما الذي نراه" : "What we can see" })).toBeVisible();
      await expectNoSeriousAxe(page);
    });
  }

  test(`axe: /${locale}/companies with the evidence drawer and bulk bar open`, async ({ page }) => {
    await gotoReady(page, `/${locale}/companies`);
    const row = page.locator('li[data-company="noon.com"]');
    await row.getByRole("checkbox").check();
    await row.getByRole("button", { name: locale === "ar" ? /لماذا تظهر هنا/ : /Why it's here/ }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expectNoSeriousAxe(page);
  });
}
