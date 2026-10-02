import type { NativeOperationSessionGuard } from "./native-operation-command.ts";
import { createTmuxSessionMutationFence } from "./tmux-session-mutation-fence.ts";
import { liveSessionIdForNativeIdentity } from "../terminal/protocol/live-session-identity.ts";
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
function rig(canDispatch?: () => boolean, sessionGuard?: () => NativeOperationSessionGuard | null) {
  const observer = {
    ownedOperationTransport: true,
    ownedOperationEpochGuard: true,
    ownedOperationPaneGuard: true,
    ownedOperationSessionGuard: false,
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
    sessionGuard,
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
      executionId: id,
      authoredReceiptAdmissionSequence: 1,
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
it.each([false, true])(
  "keeps the real session fence across awaits and isolates concurrent outside work (throws=%s)",
  async (throws) => {
    const fence = createTmuxSessionMutationFence(),
      r = rig(() => !fence.active);
    let entered!: () => void, resume!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const failure = new Error("mutation failed");
    const lane = fence.execute({
      liveSessionId: liveSessionIdForNativeIdentity("123", "$4", "567"),
      sessionName: "w",
      run: async (args) => {
        expect(args).toEqual([
          "list-sessions",
          "-F",
          "#{pid}\t#{session_id}\t#{session_created}\t#{session_name}",
        ]);
        return "123\t$4\t567\tw\n";
      },
      mutate: async () => {
        expect(fence.active).toBe(true);
        expect(r.run(r.request)).toBeNull();
        expect(r.observer.admitOwnedOperation).not.toHaveBeenCalled();
        expect(r.runTmux).not.toHaveBeenCalled();
        entered();
        await barrier;
        await Promise.resolve();
        expect(fence.active).toBe(true);
        const admitted = r.observer.admitOwnedOperation.mock.calls.length,
          dispatched = r.runTmux.mock.calls.length;
        expect(r.run(r.request)).toBeNull();
        expect(r.observer.admitOwnedOperation).toHaveBeenCalledTimes(admitted);
        expect(r.runTmux).toHaveBeenCalledTimes(dispatched);
        if (throws) throw failure;
        return "finished";
      },
    });
    // Catch before releasing the throwing lane to keep rejected-promise handling explicit.
    const settled = lane.then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error }),
    );
    await enteredPromise;
    expect(fence.active).toBe(false);
    expect(r.run(r.request)).toEqual({ output: "terminal\n\n" });
    expect(r.runTmux).toHaveBeenCalledTimes(1);
    resume();
    const outcome = await settled;
    expect(outcome).toEqual(
      throws ? { value: null, error: failure } : { value: "finished", error: null },
    );
    expect(fence.active).toBe(false);
    expect(r.run(r.request)).toEqual({ output: "terminal\n\n" });
    expect(r.runTmux).toHaveBeenCalledTimes(2);
  },
);

it("carries an immutable actual session fence into guarded dispatch only when supported", async () => {
  const fence = createTmuxSessionMutationFence();
  const r = rig(undefined, () => fence.snapshot());
  await fence.execute({
    liveSessionId: liveSessionIdForNativeIdentity("123", "$4", "567"),
    sessionName: "w",
    run: async () => "123\t$4\t567\tw\n",
    mutate: async () => {
      await Promise.resolve();
      const captured = fence.snapshot()!;
      expect(Object.isFrozen(captured)).toBe(true);
      expect(captured).toEqual({ id: "$4", created: "567", name: "w" });
      expect(r.run(r.request)).toBeNull();
      expect(r.observer.admitOwnedOperation).not.toHaveBeenCalled();
      r.observer.ownedOperationSessionGuard = true;
      expect(r.run(r.request)).toEqual({ output: "terminal\n\n" });
      expect(r.runTmux.mock.calls[0]![0]).toEqual(
        expect.arrayContaining(["-s", "w", "-S", "$4", "-C", "567"]),
      );
    },
  });
  expect(fence.snapshot()).toBeNull();
  expect(r.runTmux).toHaveBeenCalledOnce();
});
