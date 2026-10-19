import { defineConfig } from "@playwright/test";

// Real extension + real native host + real servers. Needs a built dist/ (npm run test:e2e:real does it).
export default defineConfig({
  testDir: "tests/real",
  testMatch: process.env.PORTLIGHT_STORE_SHOTS ? "store.spec.ts" : "real.spec.ts",
  workers: 1,
  timeout: 60_000,
  reporter: [["list"]],
});
