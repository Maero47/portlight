import { defineConfig, devices } from "@playwright/test";
import { MAC_UA } from "./playwright.config.ts";

// Motion performance numbers (frame pacing on open/refresh, idle CPU). Not part of npm test:
// the numbers depend on the machine. `npm run perf:motion` for the numbers, `npm run record:motion` for the clips.
export default defineConfig({
  testDir: "tests/perf",
  testMatch: "*.perf.ts",
  fullyParallel: true,
  workers: 1,
  timeout: 90_000,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    // Full Chromium (new headless) composites like the real browser; the headless shell does not.
    channel: "chromium",
    userAgent: MAC_UA,
    viewport: { width: 360, height: 540 },
    deviceScaleFactor: 2,
  },
});
