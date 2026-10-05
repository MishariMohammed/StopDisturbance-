import { existsSync, writeFileSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

// E2E against the local dev database. The app runs under `next dev` because the test-only auth
// bypass (E2E_AUTH_BYPASS=1) is compiled out of production builds (NODE_ENV=production).
const PORT = Number(process.env.E2E_PORT ?? 3100);
// E2E_DIST_DIR runs this dev server from its own build directory and tsconfig, so it can run next to
// another `next dev` in the same checkout (pair it with E2E_PORT and its own DATABASE_URL).
const DIST_DIR = process.env.E2E_DIST_DIR;
const TSCONFIG = "tsconfig.e2e.json";
if (DIST_DIR && !existsSync(TSCONFIG)) writeFileSync(TSCONFIG, JSON.stringify({ extends: "./tsconfig.json" }, null, 2) + "\n");

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./tests/e2e/global-setup.ts",
  // Visual baselines (visual.spec.ts) live next to the specs, one set per OS font stack.
  snapshotPathTemplate: "{testDir}/__screenshots__/{testFilePath}/{arg}-{platform}{ext}",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: `npx next dev --port ${PORT}`,
    url: `http://localhost:${PORT}/en/what-we-see`,
    env: {
      E2E_AUTH_BYPASS: "1",
      NEXT_TELEMETRY_DISABLED: "1",
      ...(DIST_DIR ? { NEXT_DIST_DIR: DIST_DIR, NEXT_TSCONFIG: TSCONFIG } : {}),
    },
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
