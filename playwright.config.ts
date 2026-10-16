import { defineConfig, devices } from "@playwright/test";

// Browser tests for the front end. They start the built server themselves, so
// run `npm run build` first (the server runs from dist/), and have the demo
// database up on 127.0.0.1:55432 (`npm run demo:db`).
//
// The app rejects Host headers other than the one it listens on, so always use
// 127.0.0.1 here, never localhost.
const PORT = 4361;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node dist/server.js",
    url: `http://127.0.0.1:${PORT}/api/connections`,
    reuseExistingServer: !process.env.CI,
    env: {
      CONNECTIONS_FILE: "demo/connections.json",
      PGPASSWORD: "demo_ro",
      PORT: String(PORT),
    },
  },
});
