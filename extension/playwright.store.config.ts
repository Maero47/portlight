import { defineConfig } from "@playwright/test";

// Verifies release/portlight-<version>.zip (npm run build:store builds it first).
export default defineConfig({
  testDir: "tests/store",
  workers: 1,
  reporter: [["list"]],
});
