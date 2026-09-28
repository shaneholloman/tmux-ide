import { InteractionObservationStatusStore } from "../lib/interaction-observation-status.ts";
import { testStockInteractionEvidence } from "../../test-support/interaction-evidence.ts";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  InteractionReceiptJournal,
  type InteractionReceiptDraft,
} from "../lib/interaction-receipt-journal.ts";
import { mountTmuxServerRoutes, type TmuxServerRoutesOptions } from "./tmux-servers.ts";
import { subscribeTmuxServerInteractions } from "@tmux-ide/daemon-client/tmux-server-interaction-events";
const a = {
  serverId: `tmux-server.${"a".repeat(32)}`,
  generation: "11111111-1111-4111-8111-111111111111",
};
const b = {
  serverId: `tmux-server.${"b".repeat(32)}`,
  generation: "22222222-2222-4222-8222-222222222222",
};
const draft: InteractionReceiptDraft = {
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
  evidence: testStockInteractionEvidence(
    "afbc7eaf-604a-4117-8296-aef44b889af1",
    "same",
    "pane.same",
  ),
};
function fixture(capacity = 256) {
  const journals = new Map([
    [a.serverId, new InteractionReceiptJournal(capacity)],
    [b.serverId, new InteractionReceiptJournal(capacity)],
  ]);
  const statuses = new Map(
    [a, b].map((scope) => [
      scope.serverId,
      new InteractionObservationStatusStore("00000000-0000-4000-8000-000000000001", scope),
    ]),
  );
  const app = new Hono();
  mountTmuxServerRoutes(app, {
    ownerToken: "token",
    owners: {
      withOwner: async (scope: typeof a, work: (owner: unknown) => unknown) =>
        work({
          catalog: async () => [],
          interactionReceipts: journals.get(scope.serverId),
          interactionObservation: statuses.get(scope.serverId),
        }),
      current: () => ({}),
    } as unknown as TmuxServerRoutesOptions["owners"],
  });
  const fetcher = ((url: string, init: RequestInit) => app.request(url, init)) as typeof fetch;
  return { app, journals, statuses, fetcher };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
describe("scoped interaction streams", () => {
  it("wakes idle streams for coverage changes without allocating receipt cursors", async () => {
    const f = fixture();
    const changed = deferred();
    const stream = subscribeTmuxServerInteractions({
      baseUrl: "http://localhost",
      ownerToken: "token",
      server: a,
      fetch: f.fetcher,
      onBatch: () => {
        throw Error("unexpected receipt");
      },
      onStatus: (status) => {
        if (status.method === "stock-hooks") changed.resolve();
      },
    });
    await stream.ready;
    expect(stream.getObservationStatus()?.coverage).toBe("unavailable");
    f.statuses.get(a.serverId)!.setStockAvailable(true);
    await changed.promise;
    expect(stream.getObservationStatus()?.coverage).toBe("partial");
    expect(stream.getCursor().cursor).toBe(0);
    stream.close();
    await stream.done;
    f.journals.forEach((j) => j.dispose());
    f.statuses.forEach((s) => s.dispose());
  });
  it("retains raw-before-request events and isolates owners with identical pane/workspace names", async () => {
    const f = fixture();
    f.journals.get(a.serverId)!.publish(draft);
    const got = deferred();
    const receipts: number[] = [];
    const first = subscribeTmuxServerInteractions({
      baseUrl: "http://localhost",
      ownerToken: "token",
      server: a,
      fetch: f.fetcher,
      onBatch: (batch) => {
        receipts.push(...batch.receipts.map((r) => r.sequence));
        got.resolve();
      },
    });
    const second = subscribeTmuxServerInteractions({
      baseUrl: "http://localhost",
      ownerToken: "token",
      server: b,
      fetch: f.fetcher,
      onBatch: () => {
        throw Error("Wrong owner delivery");
      },
    });
    await Promise.all([first.ready, second.ready, got.promise]);
    expect(receipts).toEqual([1]);
    expect(second.getCursor().cursor).toBe(0);
    first.close();
    second.close();
    f.journals.forEach((j) => j.dispose());
    await Promise.all([first.done, second.done]);
  });
  it("reconnects at the delivered cursor and reports retention gaps across bounded batches", async () => {
    const f = fixture(70);
    const journal = f.journals.get(a.serverId)!;
    for (let i = 0; i < 100; i++) journal.publish(draft);
    const got = deferred();
    const batches: { cursor: number; gap: unknown; size: number }[] = [];
    const stream = subscribeTmuxServerInteractions({
      baseUrl: "http://localhost",
      ownerToken: "token",
      server: a,
      fetch: f.fetcher,
      onBatch: (batch) => {
        batches.push({ cursor: batch.cursor, gap: batch.gap, size: batch.receipts.length });
        if (batch.cursor === 100) got.resolve();
      },
    });
    await got.promise;
    expect(batches).toEqual([
      { cursor: 94, gap: { from: 1, through: 30 }, size: 64 },
      { cursor: 100, gap: null, size: 6 },
    ]);
    await vi.waitFor(() => expect(stream.getCursor().cursor).toBe(100));
    const resume = stream.getCursor();
    stream.close();
    await stream.done;
    journal.publish(draft);
    const replayed = deferred();
    const seen: number[] = [];
    const next = subscribeTmuxServerInteractions({
      baseUrl: "http://localhost",
      ownerToken: "token",
      server: a,
      resume,
      fetch: f.fetcher,
      onBatch: (batch) => {
        seen.push(...batch.receipts.map((r) => r.sequence));
        replayed.resolve();
      },
    });
    await replayed.promise;
    expect(seen).toEqual([101]);
    next.close();
    journal.dispose();
    await next.done;
  });
  it("releases a stalled reader after the bounded write deadline", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const journal = f.journals.get(a.serverId)!;
    try {
      const path = `/api/v1/tmux-servers/${a.serverId}/${a.generation}/interaction-events`;
      const response = await f.app.request(path, { headers: { Authorization: "Bearer token" } });
      // Fill beyond the ready frame without reading; backpressure must release the reader.
      for (let i = 0; i < 256; i++) journal.publish(draft);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(30_001);
      const subscriptions = Array.from({ length: 64 }, () => journal.subscribe(() => {}));
      subscriptions.forEach((close) => close());
      await response.body?.cancel();
    } finally {
      f.journals.forEach((j) => j.dispose());
      vi.useRealTimers();
    }
  });
  it("requires owner authentication and rejects future cursors before SSE", async () => {
    const f = fixture();
    const path = `/api/v1/tmux-servers/${a.serverId}/${a.generation}/interaction-events`;
    expect((await f.app.request(path)).status).toBe(401);
    expect(
      (await f.app.request(path + "?after=1", { headers: { Authorization: "Bearer token" } }))
        .status,
    ).toBe(400);
    f.journals.forEach((j) => j.dispose());
  });
  it("retires idle subscribers without inventory polling", async () => {
    const f = fixture();
    const stream = subscribeTmuxServerInteractions({
      baseUrl: "http://localhost",
      ownerToken: "token",
      server: a,
      fetch: f.fetcher,
      onBatch: () => {},
    });
    await stream.ready;
    f.journals.get(a.serverId)!.dispose();
    await expect(stream.done).rejects.toThrow("retired");
  });
});
