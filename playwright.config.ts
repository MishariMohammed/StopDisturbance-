import { defineConfig, devices } from "@playwright/test";

// E2E against the local dev database. The app runs under `next dev` because the test-only auth
// bypass (E2E_AUTH_BYPASS=1) is compiled out of production builds (NODE_ENV=production).
const PORT = Number(process.env.E2E_PORT ?? 3100);

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
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: `npx next dev --port ${PORT}`,
    url: `http://localhost:${PORT}/en/what-we-see`,
    env: { E2E_AUTH_BYPASS: "1", NEXT_TELEMETRY_DISABLED: "1" },
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
