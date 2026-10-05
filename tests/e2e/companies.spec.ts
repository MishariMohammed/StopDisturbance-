import { expect, test, type Page } from "@playwright/test";
import { gotoReady, reseed, waitForHydration } from "./helpers";

test.beforeEach(reseed);

const row = (page: Page, domain: string) => page.locator(`li[data-company="${domain}"]`);
const rowCheckboxes = (page: Page) => page.locator("li[data-company] input[type=checkbox]");

test("lists only companies with evidence and nothing is pre-selected", async ({ page }) => {
  await gotoReady(page, "/en/companies");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Companies found: 40");
  await expect(rowCheckboxes(page)).toHaveCount(40);
  await expect(page.getByText("Ghost Corp")).toHaveCount(0);
  await expect(page.getByText("friend@gmail.com")).toHaveCount(0);
  for (const cb of await rowCheckboxes(page).all()) await expect(cb).not.toBeChecked();
  await expect(page.locator("li[data-company] input[type=radio]:checked")).toHaveCount(0);
  await expect(page.getByRole("toolbar", { name: "Bulk actions" })).toHaveCount(0);

  // Evidence drawer: counts, seen range, subjects, rule reasons.
  await row(page, "noon.com").getByRole("button", { name: /Why it's here/ }).click();
  const drawer = page.getByRole("dialog", { name: "Noon" });
  await expect(drawer.getByText("Order or account emails (80)")).toBeVisible();
  await expect(drawer.getByText("Has a one-click unsubscribe header")).toBeVisible();
  await expect(drawer.getByText("Your Noon order has shipped")).toBeVisible();
  await expect(drawer.getByText("Seen")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);

  // A single decision persists.
  await row(page, "shein.com").getByText("Keep", { exact: true }).click();
  await page.reload();
  await waitForHydration(page);
  await expect(row(page, "shein.com").getByRole("radio", { name: "Keep" })).toBeChecked();
});

test("bulk Remove skips low-confidence companies with a notice", async ({ page }) => {
  await gotoReady(page, "/en/companies");
  await row(page, "noon.com").getByRole("checkbox").check();
  await row(page, "careem.com").getByRole("checkbox").check(); // LOW confidence
  await expect(page.getByRole("toolbar", { name: "Bulk actions" })).toContainText("2 selected");
  await page.getByRole("button", { name: "Mark Remove" }).click();
  await expect(page.getByRole("status").filter({ hasText: "1 low-confidence companies skipped" })).toBeVisible();
  await expect(row(page, "noon.com").getByRole("radio", { name: "Remove my data" })).toBeChecked();
  await expect(row(page, "careem.com").getByRole("radio", { name: "Remove my data" })).not.toBeChecked();
});

test("bulk Remove of more than 25 asks for confirmation naming the count and biggest names", async ({ page }) => {
  await gotoReady(page, "/en/companies");
  await page.getByLabel("Select all 40 matching").check();
  await page.getByRole("button", { name: "Mark Remove" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading")).toHaveText("Mark 30 companies as “Remove my data”?");
  await expect(dialog).toContainText("Noon, مكتبة جرير, Shein");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator("li[data-company] input[type=radio]:checked")).toHaveCount(0);

  await page.getByRole("button", { name: "Mark Remove" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Mark 30 as Remove" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Marked 30" })).toContainText("10 low-confidence companies skipped");
  await expect(page.locator("li[data-company] input[type=radio][value=REMOVE]:checked")).toHaveCount(30);
});

test("filters round-trip through the URL", async ({ page }) => {
  await gotoReady(page, "/en/companies");
  await page.getByRole("link", { name: /^Holds data/ }).click();
  await expect(page).toHaveURL(/[?&]cat=data/);
  await expect(rowCheckboxes(page)).toHaveCount(27);
  await page.getByLabel("Sort").selectOption("recent");
  await expect(page).toHaveURL(/cat=data.*sort=recent|sort=recent.*cat=data/);
  await page.reload();
  // The reloaded document must be hydrated before going back: until the app router mounts, nothing
  // listens for popstate, so the URL would change while the page kept showing sort=recent.
  await waitForHydration(page);
  await expect(page.getByRole("link", { name: /^Holds data/ })).toHaveAttribute("aria-current", "true");
  await expect(page.getByLabel("Sort")).toHaveValue("recent");
  await expect(rowCheckboxes(page)).toHaveCount(27);
  await page.goBack();
  await expect(page).toHaveURL(/cat=data$/);
  await expect(page.getByLabel("Sort")).toHaveValue("emails");

  // Arabic search normalisation: taa marbuta typed as haa still matches.
  await gotoReady(page, `/ar/companies?q=${encodeURIComponent("مكتبه")}`);
  await expect(rowCheckboxes(page)).toHaveCount(1);
  await expect(row(page, "jarir.com")).toBeVisible();
  await page.getByLabel("ابحث عن شركة أو نطاق").fill("noon");
  await expect(page).toHaveURL(/q=noon/);
  await expect(rowCheckboxes(page)).toHaveCount(2);
});

test("merge and split work with the keyboard only", async ({ page }) => {
  await gotoReady(page, "/en/companies?q=noon");
  await expect(rowCheckboxes(page)).toHaveCount(2);
  await row(page, "noon.com").getByRole("checkbox").focus();
  await page.keyboard.press("Space");
  await row(page, "noon.ae").getByRole("checkbox").focus();
  await page.keyboard.press("Space");
  await page.getByRole("toolbar").getByRole("button", { name: "Merge 2 into one" }).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("radio", { name: /Noon \(noon\.com\)/ })).toBeChecked();
  await dialog.getByRole("button", { name: "Merge 2 into one" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Merged 2 companies into Noon" })).toBeVisible();
  await expect(rowCheckboxes(page)).toHaveCount(1);

  await row(page, "noon.com").getByRole("button", { name: /Why it's here/ }).focus();
  await page.keyboard.press("Enter");
  const drawer = page.getByRole("dialog", { name: "Noon" });
  await expect(drawer.locator("bdi", { hasText: "noon.ae" })).toBeVisible();
  await drawer.getByRole("button", { name: "Split out noon.ae" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "noon.ae is now listed as its own company." })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(rowCheckboxes(page)).toHaveCount(2);
});

test("pagination: pages split the list, but select-all, bulk Remove and its confirmation cover every page", async ({ page }) => {
  await gotoReady(page, "/en/companies?per=25");
  await expect(rowCheckboxes(page)).toHaveCount(25);
  const pages = page.getByRole("navigation", { name: "Pages" });
  await expect(pages).toContainText("Page 1 of 2 · showing 1–25 of 40");
  await page.getByLabel("Select all 40 matching").check();
  await expect(page.getByRole("toolbar", { name: "Bulk actions" })).toContainText("40 selected (15 on other pages)");
  await page.getByRole("button", { name: "Mark Remove" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Mark 30 as Remove" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Marked 30" })).toBeVisible();

  // Page 2 keeps the filters and page size in the URL, and shows the rows marked from page 1.
  await pages.getByRole("link", { name: /Next/ }).click();
  await expect(page).toHaveURL(/per=25&page=2/);
  await expect(rowCheckboxes(page)).toHaveCount(15);
  await expect(pages).toContainText("Page 2 of 2 · showing 26–40 of 40");
  const removedOnPage2 = await page.locator("li[data-company] input[type=radio][value=REMOVE]:checked").count();
  await pages.getByRole("link", { name: /Previous/ }).click();
  await expect(page).not.toHaveURL(/page=2/);
  expect(removedOnPage2 + (await page.locator("li[data-company] input[type=radio][value=REMOVE]:checked").count())).toBe(30);

  // A filter change keeps the page size and goes back to page 1.
  await page.getByRole("link", { name: /^Holds data/ }).click();
  await expect(page).toHaveURL(/cat=data&per=25$/);
  await expect(rowCheckboxes(page)).toHaveCount(25);
});
