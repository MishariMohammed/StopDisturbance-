import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import { expectNoSeriousAxe, gotoReady, reseed, waitForHydration } from "./helpers";

// 04-ux §10–§11: one axe sweep over every route, in both locales, with 0 serious/critical violations.
// Dialog and drawer states are covered here (companies) and in review.spec / tracker.spec.

test.beforeAll(reseed);

async function requestId(reference: string) {
  const db = new PrismaClient();
  try {
    return (await db.request.findUniqueOrThrow({ where: { reference } })).id;
  } finally {
    await db.$disconnect();
  }
}

type Route = { name: string; path: () => Promise<string> | string; signedOut?: boolean; ready?: string };

const ROUTES: Route[] = [
  { name: "login", path: () => "login", signedOut: true },
  { name: "what-we-see", path: () => "what-we-see" },
  { name: "connect", path: () => "connect" },
  { name: "scan", path: () => "scan" },
  { name: "companies", path: () => "companies", ready: "li[data-company]" },
  { name: "review (one by one)", path: () => "review", ready: "article[data-outbound]" },
  { name: "review (list)", path: () => "review?view=list", ready: "table" },
  { name: "tracker", path: () => "tracker", ready: "li[data-request]" },
  { name: "tracker/[id]", path: async () => `tracker/${await requestId("SD-NMS1")}`, ready: "li[data-reply]" },
  { name: "settings", path: () => "settings" },
  { name: "settings/data", path: () => "settings/data" },
];

for (const locale of ["ar", "en"] as const) {
  for (const route of ROUTES) {
    test(`axe sweep: /${locale}/${route.name} has no serious or critical issues`, async ({ page, context }) => {
      if (route.signedOut) await context.addCookies([{ name: "e2e-signed-out", value: "1", url: test.info().project.use.baseURL! }]);
      const res = await page.goto(`/${locale}/${await route.path()}`);
      expect(res?.status(), "route renders").toBeLessThan(400);
      await waitForHydration(page);
      if (route.name === "login") await expect(page).toHaveURL(new RegExp(`/${locale}/login$`));
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
      await expect(page.locator("h1").first()).toBeVisible();
      if (route.ready) await expect(page.locator(route.ready).first()).toBeVisible();
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
