/** Explicit client Solid runtime; never resolve ws through its browser stub. */
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^solid-js$/,
        replacement: fileURLToPath(import.meta.resolve("solid-js/dist/solid.js")),
      },
      { find: /^ws$/, replacement: fileURLToPath(import.meta.resolve("ws")) },
    ],
  },
  test: {
    environment: "node",
    maxWorkers: 1,
    include: ["scripts/qualify-spark-recovery.test.ts"],
    testTimeout: 300000,
  },
});
