import { describe, expect, it } from "vitest";

import { memorablePaneName, resolvePaneDisplayName } from "./pane-display-name.ts";

describe("pane display names", () => {
  it("creates stable memorable names from semantic identity", () => {
    expect(memorablePaneName("pane.alpha")).toBe(memorablePaneName("pane.alpha"));
    expect(memorablePaneName("pane.alpha")).toMatch(/^[a-z]+-[a-z]+$/u);
    expect(memorablePaneName("pane.alpha")).not.toBe(memorablePaneName("pane.beta"));
  });

  it("uses a foreground application and returns to the stable idle name", () => {
    expect(
      resolvePaneDisplayName({ semanticPaneId: "pane.alpha", currentCommand: "macmon" }),
    ).toEqual({ name: "macmon", source: "process" });
    expect(resolvePaneDisplayName({ semanticPaneId: "pane.alpha", currentCommand: "zsh" })).toEqual(
      { name: memorablePaneName("pane.alpha"), source: "generated" },
    );
  });

  it("does not mistake a shell hostname for the pane's job", () => {
    expect(
      resolvePaneDisplayName({
        semanticPaneId: "pane.alpha",
        currentCommand: "zsh",
        title: "Thijs-MacBook-Pro.fritz.box",
      }),
    ).toEqual({ name: memorablePaneName("pane.alpha"), source: "generated" });
  });

  it("keeps generated shell pane identities when Linux or short hostnames become OSC titles", () => {
    for (const [hostName, title] of [
      ["runnervmejwal", "runnervmejwal"],
      ["builder.example.test", "builder"],
      ["Builder", "builder"],
    ]) {
      const input = {
        semanticPaneId: "pane.alpha",
        configuredName: memorablePaneName("pane.alpha"),
        currentCommand: "bash",
        hostName,
        title,
      };
      expect(resolvePaneDisplayName(input)).toEqual({
        name: memorablePaneName("pane.alpha"),
        source: "generated",
      });
      expect(
        resolvePaneDisplayName({
          ...input,
          configuredName: "My shell",
          configuredNameSource: "manual",
        }),
      ).toEqual({ name: "My shell", source: "manual" });
      expect(resolvePaneDisplayName({ ...input, title: "Deploy logs" })).toEqual({
        name: "Deploy logs",
        source: "title",
      });
      expect(resolvePaneDisplayName({ ...input, currentCommand: "btop" })).toEqual({
        name: "btop",
        source: "process",
      });
    }
  });

  it("recognizes a persisted deterministic fallback without source metadata", () => {
    expect(
      resolvePaneDisplayName({
        semanticPaneId: "pane.alpha",
        configuredName: memorablePaneName("pane.alpha"),
        currentCommand: "macmon",
      }),
    ).toEqual({ name: "macmon", source: "process" });
  });

  it("keeps manual names authoritative over process and title changes", () => {
    expect(
      resolvePaneDisplayName({
        semanticPaneId: "pane.alpha",
        configuredName: "My monitor",
        configuredNameSource: "manual",
        currentCommand: "macmon",
        title: "other",
      }),
    ).toEqual({ name: "My monitor", source: "manual" });
  });

  it("preserves agent names and ignores old generic Terminal labels", () => {
    expect(
      resolvePaneDisplayName({
        semanticPaneId: "pane.agent",
        configuredName: "Codex",
        configuredNameSource: "agent",
        currentCommand: "node",
      }),
    ).toEqual({ name: "Codex", source: "agent" });
    expect(
      resolvePaneDisplayName({
        semanticPaneId: "pane.legacy",
        configuredName: "Terminal",
        currentCommand: "zsh",
      }),
    ).toEqual({ name: memorablePaneName("pane.legacy"), source: "generated" });
  });
});

it("adopts teammate titles ahead of automatic harness labels without changing identity", () => {
  const input = {
    semanticPaneId: "pane.member",
    currentCommand: "claude",
    configuredName: "claude",
    title: "Architect",
  };
  expect(resolvePaneDisplayName(input)).toEqual({ name: "Architect", source: "title" });
  expect(
    resolvePaneDisplayName({
      ...input,
      configuredName: "My architect",
      configuredNameSource: "manual",
      agentDisplayName: "Other",
    }),
  ).toEqual({ name: "My architect", source: "manual" });
  expect(resolvePaneDisplayName({ ...input, title: "Reviewer\u001b[2J" }).name).not.toContain(
    "Reviewer",
  );
  expect(resolvePaneDisplayName({ ...input, title: "Claude Code" }).source).toBe("process");
});

it("keeps manual names above verified team names and team names above changing activity titles", () => {
  const pane = {
    semanticPaneId: "pane.team",
    configuredName: "claude",
    currentCommand: "claude",
    title: "Investigating logs",
    agentDisplayName: "Claude Code",
    teamMemberName: "researcher",
  };
  expect(resolvePaneDisplayName(pane)).toEqual({ name: "researcher", source: "agent" });
  expect(resolvePaneDisplayName({ ...pane, title: "Done" }).name).toBe("researcher");
  expect(
    resolvePaneDisplayName({
      ...pane,
      configuredName: "My reviewer",
      configuredNameSource: "manual",
    }),
  ).toEqual({ name: "My reviewer", source: "manual" });
  expect(resolvePaneDisplayName({ ...pane, teamMemberName: null }).name).toBe("Investigating logs");
});
