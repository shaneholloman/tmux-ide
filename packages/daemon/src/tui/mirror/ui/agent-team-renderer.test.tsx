/* @jsxImportSource @opentui/solid */
import { describe, it, expect } from "bun:test";
import { AgentRow } from "./agent-row.tsx";
import { renderForTest, expectFrameBounds } from "../testing/renderer-harness.test.ts";
import { createSemanticThemeSnapshot } from "../theme.ts";

describe("shared team presentation", () => {
  for (const mode of ["light", "dark"] as const) {
    for (const compact of [false, true]) {
      it(`keeps team context and member name legible in ${mode}, compact=${compact}`, async () => {
        const setup = await renderForTest(
          () => (
            <AgentRow
              theme={createSemanticThemeSnapshot({ mode })}
              id="member"
              name="reader"
              context="Local · main"
              activity="idle"
              team={{ id: "team.1234567890123456", name: "Release crew", source: "manual" }}
              width={60}
              compact={compact}
              onOpen={() => {}}
            />
          ),
          { width: 60, height: 3 },
        );
        try {
          await setup.renderOnce();
          const frame = setup.captureCharFrame();
          expect(frame).toContain("reader");
          expect(frame).toContain("Release crew");
          expectFrameBounds(frame, 60, 3);
        } finally {
          setup.renderer.destroy();
        }
      });
    }
  }
});
