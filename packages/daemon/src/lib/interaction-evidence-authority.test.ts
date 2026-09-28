import { describe, expect, it } from "vitest";
import { InteractionEvidenceAuthority } from "./interaction-evidence-authority.ts";

const environmentId = "00000000-0000-4000-8000-000000000001";
const generation = "00000000-0000-4000-8000-000000000002";
const serverScope = { serverId: `tmux-server.${"a".repeat(32)}`, generation };
const pane = {
  workspaceName: "workspace.project",
  sessionName: "project",
  sessionId: "$1",
  runtimePaneId: "%0",
  semanticPaneId: "pane.editor",
};
const observed = {
  runtimePaneId: pane.runtimePaneId,
  sessionId: pane.sessionId,
  semanticPaneId: pane.semanticPaneId,
};

describe("interaction evidence authority", () => {
  it("captures immutable scoped snapshots and never resolves another server's colliding pane", () => {
    const first = new InteractionEvidenceAuthority(environmentId, serverScope);
    const second = new InteractionEvidenceAuthority(environmentId, {
      ...serverScope,
      generation: environmentId,
    });
    first.adoptInventory([pane]);
    second.adoptInventory([pane]);
    const snapshot = first.captureAuthoredEndpoint(pane.workspaceName, pane.semanticPaneId)!;
    expect(snapshot).toMatchObject({ kind: "pane", serverScope });
    expect(second.isCurrent(snapshot)).toBe(false);
    snapshot.workspaceName = "changed";
    expect(
      first.captureAuthoredEndpoint(pane.workspaceName, pane.semanticPaneId)?.workspaceName,
    ).toBe(pane.workspaceName);
  });
  it("retains closed-pane history briefly but never infers a target from recycled metadata", () => {
    let now = 100;
    const owner = new InteractionEvidenceAuthority(environmentId, serverScope, () => now);
    owner.adoptInventory([pane]);
    const original = owner.captureObservedEndpoint(observed);
    owner.adoptInventory([]);
    expect(owner.captureObservedEndpoint(observed)).toEqual(original);
    expect(owner.captureAuthoredEndpoint(pane.workspaceName, pane.semanticPaneId)).toBeNull();
    owner.adoptInventory([pane]);
    expect(owner.captureObservedEndpoint(observed).kind).toBe("unresolved-pane");
    now += 30_001;
    // Expiring historical details must never let an old retained record bind
    // to a replacement. Ambiguity tombstones last for the owner generation.
    expect(owner.captureObservedEndpoint(observed).kind).toBe("unresolved-pane");
    expect(owner.captureObservedEndpoint(observed)).not.toEqual(original);
  });
  it("preserves lifetime across linked sessions and freezes old workspace associations", () => {
    const owner = new InteractionEvidenceAuthority(environmentId, serverScope);
    const linked = {
      ...pane,
      workspaceName: "workspace.linked",
      sessionName: "linked",
      sessionId: "$2",
    };
    owner.adoptInventory([pane, linked]);
    const a = owner.captureAuthoredEndpoint(pane.workspaceName, pane.semanticPaneId)!;
    const b = owner.captureAuthoredEndpoint(linked.workspaceName, pane.semanticPaneId)!;
    expect(a.paneLifetimeId).toBe(b.paneLifetimeId);
    owner.adoptSessionInventory(pane.sessionName, []);
    expect(owner.isCurrent(b)).toBe(true);
    expect(owner.captureObservedEndpoint(observed)).toEqual(a);
    expect(owner.captureObservedEndpoint({ ...observed, sessionId: "$9" }).kind).toBe(
      "unresolved-pane",
    );
  });
  it("refuses ambiguous semantic bindings and validates source grant against current inventory", () => {
    const owner = new InteractionEvidenceAuthority(environmentId, serverScope);
    owner.adoptInventory([pane, { ...pane, runtimePaneId: "%1" }]);
    expect(owner.captureAuthoredEndpoint(pane.workspaceName, pane.semanticPaneId)).toBeNull();
    owner.adoptInventory([pane]);
    const grant = {
      bindingId: generation,
      session: pane.sessionName,
      runtimePaneId: pane.runtimePaneId,
      semanticPaneId: pane.semanticPaneId,
    };
    expect(owner.captureSourceBinding(grant)?.bindingId).toBe(generation);
    expect(owner.captureSourceBinding({ ...grant, runtimePaneId: "%2" })).toBeNull();
    owner.dispose();
    expect(() => owner.captureSourceBinding(grant)).toThrow("retired");
  });
  it("fails closed on oversized inventory and retires removed bindings", () => {
    const owner = new InteractionEvidenceAuthority(environmentId, serverScope);
    owner.adoptInventory([pane]);
    const endpoint = owner.captureAuthoredEndpoint(pane.workspaceName, pane.semanticPaneId)!;
    owner.adoptInventory(Array.from({ length: 4097 }, () => pane));
    expect(owner.isCurrent(endpoint)).toBe(false);
    expect(owner.captureObservedEndpoint(observed).kind).toBe("unresolved-pane");
  });
});
