import { describe, expect, it, vi } from "vitest";
import { createTmuxInteractionObservationHandler } from "./tmux-interaction-observation-handler.ts";
import type { ExternalTmuxInteraction } from "./tmux-external-interaction-observer.ts";

const observation: ExternalTmuxInteraction = {
  workspaceName: "same-name",
  semanticPaneId: "pane.same",
  operationKind: "workspace.pane.send",
  operationId: null,
};
function harness() {
  const policy = {
    consumeAuthored: vi.fn(() => false),
    publishExternal: vi.fn(),
    invalidateInventory: vi.fn(),
    reportPublicationFailure: vi.fn(),
  };
  return { ...policy, handle: createTmuxInteractionObservationHandler(policy) };
}
describe("owner-injected tmux observation policy", () => {
  it("publishes unknown raw input only through the selected owner", () => {
    const first = harness();
    const second = harness();
    expect(first.handle(observation)).toBe(false);
    expect(first.publishExternal).toHaveBeenCalledWith(observation);
    expect(first.consumeAuthored).not.toHaveBeenCalled();
    expect(first.invalidateInventory).toHaveBeenCalledOnce();
    expect(second.publishExternal).not.toHaveBeenCalled();
  });
  it("does not turn every observed read into an inventory refresh", () => {
    const policy = harness();
    policy.handle({ ...observation, operationKind: "workspace.pane.read" });
    expect(policy.publishExternal).toHaveBeenCalledOnce();
    expect(policy.invalidateInventory).not.toHaveBeenCalled();
  });
  it("consumes known authored operations once without an external duplicate", () => {
    const policy = harness();
    policy.consumeAuthored.mockReturnValue(true);
    const authored = { ...observation, operationId: "claimed-operation" };
    expect(policy.handle(authored)).toBe(true);
    expect(policy.consumeAuthored).toHaveBeenCalledExactlyOnceWith(authored);
    expect(policy.publishExternal).not.toHaveBeenCalled();
  });
  it("removes unaccepted marker claims before publishing an external observation", () => {
    const policy = harness();
    expect(policy.handle({ ...observation, operationId: "unrecognized-operation" })).toBe(false);
    expect(policy.publishExternal).toHaveBeenCalledExactlyOnceWith(observation);
  });
  it("reports publication failure without inventing authored consumption", () => {
    const policy = harness();
    const error = new Error("journal unavailable");
    policy.publishExternal.mockImplementation(() => {
      throw error;
    });
    expect(policy.handle(observation)).toBe(false);
    expect(policy.reportPublicationFailure).toHaveBeenCalledExactlyOnceWith(error);
  });
});
