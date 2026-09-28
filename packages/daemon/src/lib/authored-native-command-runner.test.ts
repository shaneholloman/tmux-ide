import { expect, it, vi } from "vitest";
import type { OwnerInteractionObservation } from "./owner-interaction-observation.ts";
import type { AuthoredNativeCommandRequest } from "./workspace-multiplexer-verbs.ts";
import { createAuthoredNativeCommandRunner } from "./authored-native-command-runner.ts";
const id = "00000000-0000-4000-8000-000000000001";
const scope = { serverId: `tmux-server.${"a".repeat(32)}`, generation: id };
const identity = { schemaVersion: 2, type: "identity", serverEpoch: id, connectionId: "7" };
const ack = {
  schemaVersion: 2,
  type: "operation-identity",
  serverEpoch: id,
  connectionId: "7",
  wrapperCommandId: "8",
  operationId: id,
};
const prefix = `${JSON.stringify(identity)}\n${JSON.stringify(ack)}\n`;
function rig(canDispatch?: () => boolean) {
  const observer = {
    ownedOperationTransport: true,
    ownedOperationEpochGuard: true,
    nativeServerEpoch: id,
    admitOwnedOperation: vi.fn(() => ({ operationId: id })),
    registerOwnedConnection: vi.fn(() => ({ bindingId: id })),
    acknowledgeOwnedOperation: vi.fn(),
    closeOwnedConnection: vi.fn(),
    noteOwnedOperationUncertainty: vi.fn(),
  };
  const runTmux = vi.fn(() => prefix + "terminal\n\n");
  const run = createAuthoredNativeCommandRunner({
    canDispatch,
    environmentId: id,
    serverScope: scope,
    observation: () => observer as unknown as OwnerInteractionObservation,
    runPinnedTmux: runTmux,
  });
  const request: AuthoredNativeCommandRequest = {
    operationId: id,
    targetPaneId: "%0",
    targetBirthId: "1",
    expectedKinds: ["capture-pane"],
    commands: [["capture-pane", "-p", "-t", "%0"]],
    context: {
      origin: "sdk",
      interactionContext: {
        destination: {
          kind: "pane",
          environmentId: id,
          serverScope: scope,
          workspaceName: "w",
          semanticPaneId: "pane.one",
          paneLifetimeId: id,
        },
        source: null,
      },
    },
  };
  return { observer, runTmux, run, request };
}
it("dispatches identity and strict wrapper on one connection and preserves captured text", () => {
  const r = rig();
  expect(r.run(r.request)).toEqual({ output: "terminal\n\n" });
  expect(r.runTmux).toHaveBeenCalledTimes(1);
  expect(r.runTmux.mock.calls[0]![0].slice(0, 8)).toEqual([
    "tmux-ide-events",
    "-i",
    ";",
    "tmux-ide-run",
    "-I",
    "-E",
    id,
    "-O",
  ]);
  expect(r.observer.registerOwnedConnection).toHaveBeenCalledWith(identity, "authored");
  expect(r.observer.acknowledgeOwnedOperation).toHaveBeenCalledWith(
    { operationId: id },
    { bindingId: id },
    ack,
  );
  expect(r.observer.closeOwnedConnection).toHaveBeenCalledTimes(1);
});
it("falls back only before dispatch if capability or native birth is unavailable", () => {
  const r = rig();
  r.observer.ownedOperationTransport = false;
  expect(r.run(r.request)).toBeNull();
  r.observer.ownedOperationTransport = true;
  r.observer.ownedOperationEpochGuard = false;
  expect(r.run(r.request)).toBeNull();
  r.observer.ownedOperationEpochGuard = true;
  expect(r.run({ ...r.request, targetBirthId: "0" })).toBeNull();
  expect(r.runTmux).not.toHaveBeenCalled();
});
it("keeps partial failure acknowledgement but never retries or substitutes success", () => {
  const r = rig();
  const failure = new Error("command failed", {
    cause: { stdout: Buffer.from(prefix + "private capture tail") },
  });
  r.runTmux.mockImplementation(() => {
    throw failure;
  });
  expect(() => r.run(r.request)).toThrow(failure);
  expect(r.runTmux).toHaveBeenCalledTimes(1);
  expect(r.observer.acknowledgeOwnedOperation).toHaveBeenCalledTimes(1);
  expect(r.observer.closeOwnedConnection).toHaveBeenCalledTimes(1);
});
it("metadata consumer failure cannot invalidate a decoded snapshot", () => {
  const r = rig();
  r.observer.acknowledgeOwnedOperation.mockImplementation(() => {
    throw new Error("metadata failed");
  });
  expect(r.run(r.request)).toEqual({ output: "terminal\n\n" });
  expect(r.observer.closeOwnedConnection).toHaveBeenCalledTimes(1);
});
it("malformed prefixes cannot escape as snapshot text or encourage resending input", () => {
  const r = rig();
  r.runTmux.mockReturnValue("private invalid prefix\n");
  expect(() => r.run(r.request)).toThrow("Native pane snapshot acknowledgement unavailable");
  expect(
    r.run({
      ...r.request,
      expectedKinds: ["send-keys"],
      commands: [["send-keys", "-l", "--", ";"]],
    }),
  ).toEqual({ output: "" });
  expect(r.observer.acknowledgeOwnedOperation).not.toHaveBeenCalled();
  expect(r.runTmux).toHaveBeenCalledTimes(2);
  expect(r.observer.noteOwnedOperationUncertainty).toHaveBeenCalledTimes(2);
});

it("reports missing failure proof without changing or replaying the original error", () => {
  const r = rig();
  const failure = new Error("connection lost");
  r.runTmux.mockImplementation(() => {
    throw failure;
  });
  r.observer.noteOwnedOperationUncertainty.mockImplementation(() => {
    throw new Error("status unavailable");
  });
  expect(() => r.run(r.request)).toThrow(failure);
  expect(r.runTmux).toHaveBeenCalledTimes(1);
  expect(r.observer.noteOwnedOperationUncertainty).toHaveBeenCalledOnce();
});

it("preserves an active outer session fence by declining native dispatch before admission", () => {
  const r = rig(() => false);
  expect(r.run(r.request)).toBeNull();
  expect(r.observer.admitOwnedOperation).not.toHaveBeenCalled();
  expect(r.runTmux).not.toHaveBeenCalled();
});
