import { describe, expect, it, vi } from "vitest";
import { createApplicationNewAgentOwner } from "./application-new-agent-owner.ts";
const key = (name: string) => ({ name, ctrl: false, meta: false, shift: false });
function rig() {
  let target = "machine/server/session/generation";
  const create = vi.fn(async () => "Created Architect");
  const note = vi.fn();
  const owner = createApplicationNewAgentOwner({
    targetKey: () => target,
    workspace: () => "review",
    create,
    setNote: note,
  });
  return {
    owner,
    create,
    note,
    replace: () => {
      target = "replacement";
    },
  };
}
describe("named agent creation", () => {
  it("requires a name and keeps harness selection separate from it", async () => {
    const { owner, create } = rig();
    owner.begin();
    owner.submit();
    expect(create).not.toHaveBeenCalled();
    owner.handlePaste(new TextEncoder().encode("Architect"));
    owner.handleKey(key("tab"));
    owner.submit();
    owner.submit();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledExactlyOnceWith({
      name: "Architect",
      harness: "codex",
      workspace: "review",
    });
    await vi.waitFor(() => expect(owner.draft()).toBeNull());
  });
  it("rejects a changed workspace instead of silently redirecting the launch", () => {
    const { owner, create, replace } = rig();
    owner.begin();
    owner.handlePaste(new TextEncoder().encode("Reviewer"));
    replace();
    owner.submit();
    expect(create).not.toHaveBeenCalled();
    expect(owner.error()).toContain("Workspace changed");
  });
  it("cancels without launching and sanitizes pasted display names", () => {
    const { owner, create } = rig();
    owner.begin();
    owner.handlePaste(new TextEncoder().encode("\u001b[31mReviewer\n"));
    expect(owner.draft()?.name).toBe("Reviewer");
    owner.handleKey(key("escape"));
    expect(owner.draft()).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });
  it("blocks blind retries after an uncertain creation", async () => {
    const { owner, create } = rig();
    create.mockRejectedValue(new Error("connection lost"));
    owner.begin();
    owner.handlePaste(new TextEncoder().encode("Reviewer"));
    owner.submit();
    await vi.waitFor(() => expect(owner.busy()).toBe(false));
    owner.submit();
    expect(create).toHaveBeenCalledTimes(1);
    expect(owner.error()).toContain("not confirmed");
  });
});
