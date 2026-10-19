import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { pinnedExtensionId } from "./scripts/extension-id.mjs";

export default defineConfig({
  root: resolve(import.meta.dirname, "src"),
  base: "./",
  publicDir: false,
  define: { __PINNED_ID__: JSON.stringify(pinnedExtensionId()) },
  build: {
    outDir: resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
    target: "chrome116",
    modulePreload: { polyfill: false },
    minify: true,
    rolldownOptions: {
      input: {
        popup: resolve(import.meta.dirname, "src/popup.html"),
        options: resolve(import.meta.dirname, "src/options.html"),
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
