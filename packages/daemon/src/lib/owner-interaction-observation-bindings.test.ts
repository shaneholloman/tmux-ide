import { afterEach, expect, it, vi } from "vitest";
import type { NativeJournalCapability, NativeJournalRecord } from "@tmux-ide/contracts";
import type { OwnedNativeInteractionDecision } from "./owned-native-interaction-bindings.ts";
import { OwnerInteractionObservation } from "./owner-interaction-observation.ts";
import { InteractionObservationStatusStore } from "./interaction-observation-status.ts";
import type {
  NativeJournalObserverEvent,
  NativeTmuxInteractionObserverOptions,
} from "./native-tmux-interaction-observer.ts";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const environmentId = id(1),
  serverEpoch = id(3),
  journalEpoch = id(4),
  operationId = id(5);
const serverScope = { serverId: `tmux-server.${"a".repeat(32)}`, generation: id(2) };
const target = {
  kind: "native-pane" as const,
  environmentId,
  serverScope,
  serverEpoch,
  paneBirthId: "1",
};
const identity = {
  schemaVersion: 2 as const,
  type: "identity" as const,
  serverEpoch,
  connectionId: "7",
};
const ack = {
  schemaVersion: 2 as const,
  type: "operation-identity" as const,
  serverEpoch,
  connectionId: "7",
  wrapperCommandId: "8",
  operationId,
};
const capability: NativeJournalCapability = {
  schemaVersion: 2,
  type: "capability",
  serverEpoch,
  journalEpoch,
  enabled: true,
  coverage: [
    "command-outcome-v1",
    "pty-enqueue-v1",
    "capture-produced-v1",
    "cooperative-operation-v1",
    "pane-identity-v1",
  ],
  capacity: 4096,
  maxBatch: 256,
  maxWaiters: 4,
  waitingReaders: 0,
  degraded: 0,
  ownedOperationTransport: "direct-wrapper-v1",
};
async function rig(owned = true, consume = false) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  vi.setSystemTime(0);
  let event!: (event: NativeJournalObserverEvent) => void;
  const completed = vi.fn();
  const publish = vi.fn(),
    publishOwned = vi.fn<(decision: OwnedNativeInteractionDecision) => boolean>(() => consume),
    dispose = vi.fn(async () => {}),
    status = new InteractionObservationStatusStore(environmentId, serverScope);
  const owner = new OwnerInteractionObservation({
    environmentId,
    serverScope,
    tmuxAuthority: {
      executablePath: "/test/tmux",
      socketSelector: { kind: "path", path: "/test/socket" },
    },
    nativeServerIdentity: { pid: "1", startTime: "1" },
    enabled: true,
    status,
    publishEvidence: publish,
    publishOwnedEvidence: publishOwned,
    onOwnedPlanComplete: completed,
    readerFactory: (options: NativeTmuxInteractionObserverOptions) => {
      event = options.onEvent;
      return {
        start: async () => {
          event({
            type: "state",
            status: "ready",
            capability: owned ? capability : { ...capability, ownedOperationTransport: undefined },
          });
          return "ready" as const;
        },
        dispose,
      };
    },
  });
  await owner.start();
  let sequence = 0;
  const batch = () => {
    const record = (kind: number): NativeJournalRecord => ({
      sequence: String(++sequence),
      kind,
      commandId: String(sequence + 10),
      issuerId: "7",
      requestId: "5",
      parentCommandId: "8",
      monotonicUs: "100",
      count: kind === 5 ? "3" : "0",
      targetId: 0,
      targetBirthId: "1",
      outcome: 1,
      flags: 1,
      transport: 1,
      derivation: 1,
      correlation: operationId,
    });
    const effect = record(5),
      outcome = record(1);
    outcome.commandId = effect.commandId;
    event({
      type: "batch",
      batch: {
        schemaVersion: 2,
        type: "batch",
        serverEpoch,
        journalEpoch,
        oldest: "1",
        newest: String(sequence),
        next: String(sequence),
        gap: null,
        degraded: 0,
        records: [effect, outcome],
      },
    });
  };
  const admit = (role: "viewer" | "authored" = "viewer") => {
    const connection = owner.registerOwnedConnection(identity, role)!;
    const permit = owner.admitOwnedOperation({
      operationId,
      role,
      target,
      commands: ["send-keys"],
      source: null,
      executionId: id(99),
      authoredDestination:
        role === "authored"
          ? {
              kind: "pane",
              environmentId,
              serverScope,
              paneLifetimeId: id(80),
              workspaceName: "space",
              semanticPaneId: "pane.target",
            }
          : undefined,
      connection,
    })!;
    return { connection, permit };
  };
  return { owner, event, batch, admit, publish, publishOwned, dispose, status, completed };
}
afterEach(() => vi.useRealTimers());
it("stages before acknowledgement and reuses one deadline timer", async () => {
  const r = await rig();
  const { connection, permit } = r.admit();
  expect(vi.getTimerCount()).toBe(1);
  r.batch();
  r.batch();
  expect(r.publish).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(1);
  r.owner.acknowledgeOwnedOperation(permit, connection, ack);
  expect(r.publish).toHaveBeenCalledTimes(2);
  expect(r.publish.mock.calls[0]![0].actor.classification.kind).toBe("viewer");
  expect(r.publish.mock.calls[1]![0].actor.classification.kind).toBe("unknown");
  expect(vi.getTimerCount()).toBe(0);
  await r.owner.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
it("expiry emits original unknown evidence and explicit uncertainty without extra timers", async () => {
  const r = await rig();
  r.admit();
  r.batch();
  await vi.advanceTimersByTimeAsync(2000);
  expect(r.publish).toHaveBeenCalledTimes(1);
  expect(r.publish.mock.calls[0]![0].actor.classification.kind).toBe("unknown");
  expect(r.status.getSnapshot().lastGap?.reason).toBe("uncertain-consume");
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(28000);
  expect(vi.getTimerCount()).toBe(0);
  expect(r.publish).toHaveBeenCalledTimes(1);
  await r.owner.dispose();
});
it("without optional native capability publishes immediately and cannot create grants", async () => {
  const r = await rig(false);
  expect(r.owner.ownedOperationTransport).toBe(false);
  expect(r.owner.registerOwnedConnection(identity, "viewer")).toBeNull();
  r.batch();
  expect(r.publish).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  await r.owner.dispose();
});
it("terminal halt flushes staged unknown records once and disables all late proof", async () => {
  const r = await rig();
  const { connection, permit } = r.admit();
  r.batch();
  r.event({ type: "state", status: "degraded", capability: { ...capability, degraded: 1 } });
  expect(r.publish).toHaveBeenCalledTimes(1);
  expect(r.publish.mock.calls[0]![0].actor.classification.kind).toBe("unknown");
  expect(r.owner.ownedOperationTransport).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  r.owner.acknowledgeOwnedOperation(permit, connection, ack);
  r.batch();
  expect(r.publish).toHaveBeenCalledTimes(1);
  await r.owner.dispose();
});
it("disposal cancels timers without publishing into a retired owner", async () => {
  const r = await rig();
  r.admit();
  r.batch();
  await r.owner.dispose();
  await vi.advanceTimersByTimeAsync(60000);
  expect(r.publish).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  expect(r.dispose).toHaveBeenCalledTimes(1);
});
it("late authored evidence survives helper close and enriches only through the optional consumer", async () => {
  const r = await rig(true, true);
  const { connection, permit } = r.admit("authored");
  r.owner.acknowledgeOwnedOperation(permit, connection, ack);
  r.owner.closeOwnedConnection(connection);
  r.batch();
  expect(r.publishOwned).toHaveBeenCalledTimes(1);
  expect(r.publishOwned.mock.calls[0]![0].proof!.acknowledgement).toEqual(ack);
  expect(r.publish).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(30000);
  expect(vi.getTimerCount()).toBe(0);
  r.batch();
  expect(r.publish).toHaveBeenCalledTimes(1);
  await r.owner.dispose();
});
it("authored proof falls back to same journal publication when no existing receipt consumes it", async () => {
  const r = await rig();
  const { connection, permit } = r.admit("authored");
  r.owner.acknowledgeOwnedOperation(permit, connection, ack);
  r.batch();
  expect(r.publishOwned).toHaveBeenCalledTimes(1);
  expect(r.publish).toHaveBeenCalledTimes(1);
  await r.owner.dispose();
});
it("a publication failure during acknowledgement cannot turn a completed action into a retry", async () => {
  const r = await rig();
  const { connection, permit } = r.admit();
  r.batch();
  r.publish.mockImplementation(() => {
    throw new Error("consumer failed");
  });
  expect(() => r.owner.acknowledgeOwnedOperation(permit, connection, ack)).not.toThrow();
  expect(r.owner.ownedOperationTransport).toBe(false);
  expect(r.status.getSnapshot().coverage).toBe("unavailable");
  expect(vi.getTimerCount()).toBe(0);
  expect(r.dispose).toHaveBeenCalledTimes(1);
  await r.owner.dispose();
});
it("reports unproven operation metadata and retires staged proof on asynchronous publication failure", async () => {
  const r = await rig();
  r.admit();
  r.batch();
  r.owner.noteOwnedOperationUncertainty();
  expect(r.status.getSnapshot().lastGap?.reason).toBe("uncertain-consume");
  r.owner.failOwnedOperationObservation();
  expect(r.owner.ownedOperationTransport).toBe(false);
  expect(r.status.getSnapshot().coverage).toBe("unavailable");
  expect(vi.getTimerCount()).toBe(0);
  expect(r.publish).not.toHaveBeenCalled();
  expect(r.dispose).toHaveBeenCalledTimes(1);
  r.owner.failOwnedOperationObservation();
  expect(r.dispose).toHaveBeenCalledTimes(1);
  await r.owner.dispose();
});
it.each([false, true])(
  "forwards complete owned plans only with uninterrupted coverage (gap=%s)",
  async (gap) => {
    const r = await rig();
    const { connection, permit } = r.admit("authored");
    r.owner.acknowledgeOwnedOperation(permit, connection, ack);
    if (gap)
      r.event({
        type: "gap",
        cursor: { serverEpoch, journalEpoch, sequence: "0" },
        missing: { from: "1", through: "1" },
      });
    r.batch();
    expect(r.completed).toHaveBeenCalledTimes(gap ? 0 : 1);
    await r.owner.dispose();
  },
);
