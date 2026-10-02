import { describe, expect, it } from "vitest";
import { statusPresentation } from "./status-presentation.ts";

describe("shared status priority", () => {
  it.each([
    [{ activity: "running", unavailable: true }, "Unavailable"],
    [{ activity: "running", connection: "rebinding", scrollback: true }, "Reconnecting…"],
    [{ activity: "running", connection: "read-only" }, "Read-only"],
    [{ activity: "disconnected", attention: true }, "Unknown"],
    [{ activity: "running", scrollback: true, expanded: true }, "Scrollback"],
    [{ activity: "running", expanded: true }, "Expanded"],
    [{ activity: "failed", attention: true, expanded: true }, "Failed"],
    [{ activity: "running", attention: true }, "Needs input"],
    [{ activity: "complete" }, "Done"],
    [{ activity: "idle" }, "Idle"],
  ] as const)("projects %j as %s without stale working animation", (facts, label) => {
    const result = statusPresentation(facts);
    expect(result?.label).toBe(label);
    expect(result?.activity).not.toBe("running");
  });
  it("does not invent an agent status for an ordinary shell", () => {
    expect(statusPresentation({})).toBeUndefined();
    expect(statusPresentation({ connection: "live" })).toBeUndefined();
  });
  it("restores live activity after leaving a local view mode", () => {
    expect(statusPresentation({ activity: "running", scrollback: true })?.action).toBe(
      "back-to-live",
    );
    expect(statusPresentation({ activity: "running" })).toMatchObject({
      label: "Working",
      activity: "running",
    });
  });
});
