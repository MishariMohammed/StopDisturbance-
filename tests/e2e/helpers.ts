import { readFileSync } from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page } from "@playwright/test";
import { seed } from "./seed";

export async function reseed() {
  try {
    process.loadEnvFile?.(".env");
  } catch {}
  await seed();
}

/**
 * Waits until React has hydrated the current document (<html data-hydrated>, set by HydrationMarker).
 * Server-rendered HTML can pass assertions before the client router and event handlers are attached;
 * a back/forward or click in that window is lost.
 */
export async function waitForHydration(page: Page) {
  await expect(page.locator("html[data-hydrated]")).toHaveCount(1);
}

/** The app's message catalogue for a locale (tests assert on the real strings in both languages). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function messages(locale: "ar" | "en"): any {
  return JSON.parse(readFileSync(path.join(process.cwd(), "messages", `${locale}.json`), "utf8"));
}

/**
 * Moves focus with Tab (or Shift+Tab) until `target`, or an element inside it, has focus. Proves the
 * control is reachable by keyboard in the real tab order; fails after `max` presses.
 */
export async function tabTo(page: Page, target: Locator, { back = false, max = 400 }: { back?: boolean; max?: number } = {}) {
  await expect(target.first()).toBeVisible();
  for (let i = 0; i < max; i++) {
    await page.keyboard.press(back ? "Shift+Tab" : "Tab");
    const hit = await target.evaluateAll((els) => els.some((el) => el === document.activeElement || el.contains(document.activeElement)));
    if (hit) return;
  }
  throw new Error(`Could not reach ${target} with ${back ? "Shift+Tab" : "Tab"} in ${max} presses`);
}

/** page.goto + waitForHydration. */
export async function gotoReady(page: Page, url: string) {
  await page.goto(url);
  await waitForHydration(page);
}

/** Fails on any serious or critical axe violation (WCAG 2.2 A/AA rule set). */
export async function expectNoSeriousAxe(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
    .analyze();
  const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).slice(0, 5).join(" | ")}`)).toEqual([]);
  return results;
}
