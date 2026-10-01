import { expect, it } from "vitest";
import { terminalPaneDisplayTitle } from "./application-terminal-workspace-policy.ts";
import {
  resolvedAgentLabel,
  resolveAgentPresentation,
  type ApplicationShellPanePresentationFacts,
} from "../../../command-center/resources/application-shell.ts";
it("uses the same teammate label for semantic agents and terminal headers", () => {
  const pane: ApplicationShellPanePresentationFacts = {
    semanticPaneId: "pane.member",
    index: 0,
    title: "Architect",
    currentCommand: "claude",
    active: true,
    role: null,
    name: "claude",
    type: "agent",
    agentKind: "claude",
  };
  expect(resolvedAgentLabel(pane, resolveAgentPresentation(pane, 100), 0)).toBe("Architect");
  expect(
    terminalPaneDisplayTitle("pane.member", { name: "Claude Code" } as never, "Architect", "title"),
  ).toBe("Architect");
  expect(
    terminalPaneDisplayTitle("pane.member", { name: "Claude Code" } as never, "Reviewer", "manual"),
  ).toBe("Reviewer");
  expect(
    resolvedAgentLabel({ ...pane, title: "Claude Code" }, resolveAgentPresentation(pane, 100), 0),
  ).toBe("Claude Code");
});

it("shows verified team names consistently above automatic titles, but preserves manual aliases", () => {
  const pane: ApplicationShellPanePresentationFacts = {
    semanticPaneId: "pane.team",
    index: 0,
    title: "Working on tests",
    currentCommand: "claude",
    active: true,
    role: null,
    name: "claude",
    type: "agent",
    agentKind: "claude",
    teamMemberName: "researcher",
  };
  const name = resolvedAgentLabel(pane, resolveAgentPresentation(pane, 100), 0);
  expect(name).toBe("researcher");
  expect(
    terminalPaneDisplayTitle(
      "pane.team",
      { name, nameResolved: true, activity: "running", attention: false },
      "Working on tests",
      "title",
    ),
  ).toBe(name);
  expect(
    terminalPaneDisplayTitle(
      "pane.team",
      {
        name: resolvedAgentLabel(
          { ...pane, name: "My reviewer", nameSource: "manual" },
          resolveAgentPresentation(pane, 100),
          0,
        ),
        nameResolved: true,
        activity: "idle",
        attention: false,
      },
      "My reviewer",
      "manual",
    ),
  ).toBe("My reviewer");
});
