import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(import.meta.dirname, "src"),
  base: "./",
  publicDir: false,
  build: {
    outDir: resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
    target: "chrome116",
    modulePreload: { polyfill: false },
    minify: true,
    rolldownOptions: {
      input: {
        popup: resolve(import.meta.dirname, "src/popup.html"),
        background: resolve(import.meta.dirname, "src/background.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
  test: {
    root: import.meta.dirname,
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
  },
});
