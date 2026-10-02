import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("both owner composition roots preserve trusted execution context", () => {
  it.each(["daemon-embed.ts", "tmux-server-owner.ts"])(
    "forwards send and read context in %s",
    (file) => {
      const source = readFileSync(new URL(`../../lib/${file}`, import.meta.url), "utf8");
      expect(source).toMatch(/\.readPane\(operationId, intent, execution\)/u);
      expect(source).toMatch(
        /\.mutate\(\s*\{ operationId, expectedDaemonInstanceId: [^,]+, intent \},\s*timing,\s*execution,/u,
      );
    },
  );
});
