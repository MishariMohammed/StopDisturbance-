import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { seed } from "./seed";

export async function reseed() {
  try {
    process.loadEnvFile?.(".env");
  } catch {}
  await seed();
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
