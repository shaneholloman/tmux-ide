import { describe, expect, it } from "bun:test";
import { subscribeTmuxServerInteractions } from "./tmux-server-interaction-events.ts";
const server = {
  serverId: `tmux-server.${"a".repeat(32)}`,
  generation: "11111111-1111-4111-8111-111111111111",
};
const observationStatus = {
  schemaVersion: 1,
  environmentId: "00000000-0000-4000-8000-000000000001",
  serverScope: server,
  method: "unavailable",
  capabilityVersion: null,
  commands: [],
  effects: [],
  coverage: "unavailable",
  cursor: null,
  lastGap: null,
  droppedCount: "0",
};
const ready = { version: 1, server, type: "ready", after: 0, observationStatus };
const receipt = {
  type: "interaction.receipt",
  sequence: 1,
  operationId: "afbc7eaf-604a-4117-8296-aef44b889af1",
  origin: "external",
  workspaceName: "same",
  sourceSemanticPaneId: null,
  target: { kind: "pane", semanticPaneId: "pane.same" },
  operationKind: "workspace.pane.send",
  phase: "observed",
  summary: { operationKind: "workspace.pane.send", observedOnly: true },
  proof: { operationKind: "workspace.pane.send", observed: true, semanticPaneId: "pane.same" },
  at: "2026-09-28T00:00:00.000Z",
  resourceRevision: null,
  evidence: {
    schemaVersion: 1,
    interactionId: "afbc7eaf-604a-4117-8296-aef44b889af1",
    revision: 0,
    endpoints: {
      destination: {
        kind: "pane",
        environmentId: observationStatus.environmentId,
        serverScope: server,
        paneLifetimeId: "00000000-0000-4000-8000-000000000003",
        workspaceName: "same",
        semanticPaneId: "pane.same",
      },
      source: null,
    },
    actor: { kind: "unknown", reason: "stock-hook" },
    observation: { kind: "stock-hook", command: "send-keys" },
    effect: { kind: "unknown" },
    occurredAt: null,
    timeBasis: "unknown",
    receivedAt: "2026-09-28T00:00:00.000Z",
  },
};
const batch = {
  version: 1,
  server,
  type: "batch",
  after: 0,
  cursor: 1,
  gap: null,
  receipts: [receipt],
};
function fake(frames: unknown[]) {
  return (async () =>
    new Response(
      new ReadableStream({
        start(c) {
          for (const f of frames)
            c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(f)}\n\n`));
          c.close();
        },
      }),
    )) as typeof fetch;
}
function subscribe(frames: unknown[], onBatch = () => {}) {
  return subscribeTmuxServerInteractions({
    baseUrl: "http://localhost",
    ownerToken: "token",
    server,
    fetch: fake(frames),
    onBatch,
  });
}
describe("interaction subscriber fences", () => {
  it("rejects status scope mismatch and missing initial coverage", async () => {
    for (const frames of [
      [{ ...ready, observationStatus: undefined }],
      [
        ready,
        {
          version: 1,
          server,
          type: "status",
          observationStatus: {
            ...observationStatus,
            serverScope: { ...server, generation: "22222222-2222-4222-8222-222222222222" },
          },
        },
      ],
    ]) {
      const stream = subscribe(frames);
      stream.ready.catch(() => {});
      await expect(stream.done).rejects.toThrow();
    }
  });
  it("delivers status-only frames without advancing receipt cursor", async () => {
    const seen: string[] = [];
    const stream = subscribeTmuxServerInteractions({
      baseUrl: "http://localhost",
      ownerToken: "token",
      server,
      fetch: fake([
        ready,
        {
          version: 1,
          server,
          type: "status",
          observationStatus: {
            ...observationStatus,
            method: "stock-hooks",
            capabilityVersion: 1,
            coverage: "partial",
            commands: ["send-keys", "capture-pane"],
          },
        },
      ]),
      onBatch: () => {
        throw Error("Unexpected batch");
      },
      onStatus: (status) => seen.push(status.method),
    });
    await stream.ready;
    await stream.done.catch(() => {});
    expect(seen).toEqual(["unavailable", "stock-hooks"]);
    expect(stream.getCursor().cursor).toBe(0);
  });
  it("closes while a consumer is stalled without acknowledging its batch", async () => {
    let started!: () => void;
    const called = new Promise<void>((resolve) => {
      started = resolve;
    });
    let consumerSignal: AbortSignal | undefined;
    const stream = subscribeTmuxServerInteractions({
      baseUrl: "http://localhost",
      ownerToken: "token",
      server,
      fetch: fake([ready, batch]),
      onBatch: (_batch, signal) => {
        consumerSignal = signal;
        started();
        return new Promise<void>(() => {});
      },
    });
    await called;
    stream.close();
    await stream.done;
    expect(consumerSignal?.aborted).toBe(true);
    expect(stream.getCursor().cursor).toBe(0);
  });
  it("rejects scoped resume reuse before making a request", () => {
    expect(() =>
      subscribeTmuxServerInteractions({
        baseUrl: "http://localhost",
        ownerToken: "token",
        server,
        resume: {
          server: { ...server, generation: "22222222-2222-4222-8222-222222222222" },
          cursor: 0,
        },
        onBatch: () => {},
      }),
    ).toThrow("another owner");
  });
  it.each(["owner", "generation", "repeated ready", "version", "before ready", "regression"])(
    "rejects %s frames",
    async (kind) => {
      let frames: unknown[] = [ready];
      if (kind === "owner")
        frames.push({ ...batch, server: { ...server, serverId: `tmux-server.${"b".repeat(32)}` } });
      if (kind === "generation")
        frames.push({
          ...batch,
          server: { ...server, generation: "22222222-2222-4222-8222-222222222222" },
        });
      if (kind === "repeated ready") frames.push(ready);
      if (kind === "version") frames.push({ ...batch, version: 2 });
      if (kind === "before ready") frames = [batch];
      if (kind === "regression") frames.push({ ...batch, cursor: 0 });
      let calls = 0;
      const stream = subscribe(frames, () => {
        calls++;
      });
      await expect(stream.done).rejects.toThrow();
      expect(calls).toBe(0);
    },
  );
  it("rejects repeated receipts without delivering them twice", async () => {
    let calls = 0;
    const stream = subscribe([ready, batch, batch], () => {
      calls++;
    });
    await expect(stream.done).rejects.toThrow("Repeated");
    expect(calls).toBe(1);
    expect(stream.getCursor().cursor).toBe(1);
  });
  it("retains only acknowledged callback progress for reconnect", async () => {
    const stream = subscribe([ready, batch], () => {
      throw Error("consumer failed");
    });
    await expect(stream.done).rejects.toThrow("consumer failed");
    expect(stream.getCursor().cursor).toBe(0);
  });
  it("rejects a fabricated gap and noncontiguous receipts", async () => {
    const stream = subscribe([ready, { ...batch, gap: { from: 2, through: 2 } }]);
    await expect(stream.done).rejects.toThrow();
    expect(stream.getCursor().cursor).toBe(0);
  });
});
