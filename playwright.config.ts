import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests drive the real frontend in a browser, with the Rust half faked
 * at the `invoke` boundary (see `tests/e2e/tauri-stub.ts`). Vite serves the same
 * bundle `tauri dev` loads, so no cargo build stands between a change and a run.
 *
 * Unit tests stay with vitest (`src/**\/*.test.ts`, a different runner and a
 * different `include`), so the two suites never collect each other's files.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? "list" : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:1420",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm dev",
    // The port is fixed and `strictPort` is on (Tauri requires it), so a dev
    // server already running is the one to use rather than a conflict to fail on.
    url: "http://localhost:1420",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
