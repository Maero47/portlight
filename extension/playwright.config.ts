import { defineConfig, devices } from "@playwright/test";

export const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    // The preset claims Windows; the mocked popup is shot as it looks on a Mac.
    userAgent: MAC_UA,
    viewport: { width: 360, height: 540 },
    deviceScaleFactor: 2,
  },
});
