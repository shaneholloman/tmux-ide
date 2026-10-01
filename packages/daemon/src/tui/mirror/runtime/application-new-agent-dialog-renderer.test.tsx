/* @jsxImportSource @opentui/solid */
import { expect, it } from "bun:test";
import { ApplicationNewAgentDialog } from "./application-new-agent-dialog.tsx";
import { createApplicationNewAgentOwner } from "./application-new-agent-owner.ts";
import { createSemanticThemeSnapshot } from "../theme.ts";
import { renderForTest } from "../testing/renderer-harness.test.ts";

it("renders a named agent using shared dialog and harness buttons", async () => {
  const owner = createApplicationNewAgentOwner({
    targetKey: () => "spark/session",
    workspace: () => "Review",
    create: async () => "Created",
    setNote: () => {},
  });
  owner.begin();
  owner.handlePaste(new TextEncoder().encode("Architect"));
  const setup = await renderForTest(
    () => (
      <ApplicationNewAgentDialog
        draft={owner.draft()!}
        owner={owner}
        width={80}
        height={24}
        theme={createSemanticThemeSnapshot({ mode: "dark" })}
        active={true}
        zIndex={100}
      />
    ),
    { width: 80, height: 24 },
  );
  try {
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("New agent");
    expect(frame).toContain("Architect");
    expect(frame).toContain("Claude Code");
    expect(frame).toContain("Codex");
    expect(frame).toContain("Create agent");
    expect(frame).toContain("Review");
  } finally {
    setup.renderer.destroy();
  }
});
