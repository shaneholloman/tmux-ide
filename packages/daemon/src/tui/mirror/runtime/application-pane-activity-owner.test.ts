import { createRoot, createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { InteractionReceiptSchemaZ, type TmuxInteractionCursor } from "@tmux-ide/contracts";
import { interactionPaneEndpointKey } from "@tmux-ide/core";
import type { TmuxInteractionSubscriptionOptions } from "@tmux-ide/daemon-client/tmux-server-interaction-events";
import {
  createApplicationPaneActivityOwner,
  type ApplicationInteractionSource,
} from "./application-pane-activity-owner.ts";
const uuid = "00000000-0000-4000-8000-000000000001";
const source = (index = 0): ApplicationInteractionSource => ({
  environmentId: uuid,
  server: { serverId: `tmux-server.${String(index).repeat(32)}`, generation: uuid },
  baseUrl: "http://localhost",
  ownerToken: "private",
});
const endpoint = (input: ApplicationInteractionSource) => ({
  kind: "pane" as const,
  environmentId: input.environmentId,
  serverScope: input.server,
  workspaceName: "workspace.alpha",
  semanticPaneId: "pane.alpha",
  paneLifetimeId: uuid,
});
function receipt(scope: ApplicationInteractionSource, sequence: number) {
  const operationId = `10000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
  const at = new Date().toISOString();
  return InteractionReceiptSchemaZ.parse({
    type: "interaction.receipt",
    sequence,
    operationId,
    origin: "sdk",
    workspaceName: "workspace.alpha",
    sourceSemanticPaneId: null,
    target: { kind: "pane", semanticPaneId: "pane.alpha" },
    operationKind: "workspace.pane.read",
    summary: { operationKind: "workspace.pane.read", observedOnly: true },
    proof: null,
    at,
    resourceRevision: null,
    phase: "accepted",
    evidence: {
      schemaVersion: 1,
      interactionId: operationId,
      revision: 0,
      endpoints: { source: null, destination: endpoint(scope) },
      actor: { kind: "unknown", reason: "unbound-source" },
      observation: { kind: "admission", operationId },
      effect: { kind: "unknown" },
      occurredAt: null,
      receivedAt: at,
      timeBasis: "unknown",
    },
  });
}
function rig(initial = [source()]) {
  const calls: {
    options: TmuxInteractionSubscriptionOptions;
    close: ReturnType<typeof vi.fn>;
    fail(error: Error): void;
    emit(sequences: number[], gap?: boolean): void;
  }[] = [];
  let dispose!: () => void;
  const value = createRoot((cleanup) => {
    dispose = cleanup;
    const [sources, setSources] = createSignal(initial);
    const activity = createApplicationPaneActivityOwner(sources, (options) => {
      let fail!: (error: Error) => void;
      let finish!: () => void;
      const done = new Promise<void>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
      let cursor: TmuxInteractionCursor = options.resume ?? { server: options.server, cursor: 0 };
      const close = vi.fn(finish);
      calls.push({
        options,
        close,
        fail,
        emit(sequences, gap = false) {
          const selected =
            initial.find((item) => item.server.serverId === options.server.serverId) ?? source();
          void options.onBatch(
            {
              version: 1,
              type: "batch",
              server: options.server,
              after: cursor.cursor,
              cursor: sequences.at(-1)!,
              gap: gap ? { from: cursor.cursor + 1, through: sequences[0]! - 1 } : null,
              receipts: sequences.map((sequence) => receipt(selected, sequence)),
            },
            new AbortController().signal,
          );
          cursor = { server: options.server, cursor: sequences.at(-1)! };
        },
      });
      return { ready: Promise.resolve(), done, close, getCursor: () => cursor };
    });
    return { activity, setSources };
  });
  return { ...value, calls, dispose };
}
afterEach(() => vi.useRealTimers());
it("consumes every receipt in a burst and expires transient presence without losing bounded history", async () => {
  vi.useFakeTimers();
  const f = rig();
  await Promise.resolve();
  try {
    f.calls[0]!.emit(Array.from({ length: 64 }, (_, index) => index + 1));
    expect(f.activity.activity()).toHaveLength(64);
    expect(f.activity().has(interactionPaneEndpointKey(endpoint(source())))).toBe(true);
    await vi.advanceTimersByTimeAsync(3201);
    expect(f.activity().size).toBe(0);
    expect(f.activity.activity()).toHaveLength(64);
  } finally {
    f.dispose();
  }
  expect(vi.getTimerCount()).toBe(0);
  expect(f.calls[0]!.close).toHaveBeenCalledOnce();
});
it("keeps equal sequence and operation IDs from two owners independent and retires one scope only", async () => {
  const sources = [source(), source(1)];
  const f = rig(sources);
  await Promise.resolve();
  try {
    f.calls[0]!.emit([1]);
    f.calls[1]!.emit([1]);
    expect(f.activity.activity()).toHaveLength(2);
    expect(f.activity().size).toBe(2);
    f.setSources([sources[1]!]);
    await Promise.resolve();
    expect(f.activity.activity()).toHaveLength(1);
    expect(f.activity().has(interactionPaneEndpointKey(endpoint(source(1))))).toBe(true);
    expect(f.calls[0]!.close).toHaveBeenCalledOnce();
    expect(f.calls[1]!.close).not.toHaveBeenCalled();
  } finally {
    f.dispose();
  }
});
it("reconnects with the exact acknowledged owner cursor and clears pre-gap transient evidence", async () => {
  vi.useFakeTimers();
  const f = rig();
  await Promise.resolve();
  try {
    f.calls[0]!.emit([1]);
    f.calls[0]!.fail(new Error("disconnected"));
    await vi.advanceTimersByTimeAsync(250);
    expect(f.calls[1]!.options.resume).toEqual({ server: source().server, cursor: 1 });
    f.calls[1]!.emit([4], true);
    expect(f.activity.activity().map((event) => event.sequence)).toEqual([4]);
  } finally {
    f.dispose();
  }
  expect(vi.getTimerCount()).toBe(0);
});
it("drops late batches after removal and never subscribes to legacy client operations", async () => {
  const f = rig();
  await Promise.resolve();
  f.setSources([]);
  await Promise.resolve();
  f.calls[0]!.emit([1]);
  expect(f.activity.activity()).toEqual([]);
  f.dispose();
});
