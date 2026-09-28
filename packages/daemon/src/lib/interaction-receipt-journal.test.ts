import { testStockInteractionEvidence } from "../../test-support/interaction-evidence.ts";
import { describe, expect, it, vi } from "vitest";
import {
  InteractionReceiptJournal,
  type InteractionReceiptDraft,
} from "./interaction-receipt-journal.ts";

const draft: InteractionReceiptDraft = {
  evidence: testStockInteractionEvidence(
    "afbc7eaf-604a-4117-8296-aef44b889af1",
    "shared-name",
    "pane.same",
  ),
  operationId: "afbc7eaf-604a-4117-8296-aef44b889af1",
  origin: "external",
  workspaceName: "shared-name",
  sourceSemanticPaneId: null,
  target: { kind: "pane", semanticPaneId: "pane.same" },
  operationKind: "workspace.pane.send",
  phase: "observed",
  summary: { operationKind: "workspace.pane.send", observedOnly: true },
  proof: { operationKind: "workspace.pane.send", observed: true, semanticPaneId: "pane.same" },
  at: "2026-09-28T00:00:00.000Z",
  resourceRevision: null,
};
describe("owner receipt journal", () => {
  it("keeps equal workspace and pane names in separate owner histories", () => {
    const a = new InteractionReceiptJournal();
    const b = new InteractionReceiptJournal();
    a.publish(draft);
    expect(a.read(0).receipts).toHaveLength(1);
    expect(b.read(0)).toEqual({ cursor: 0, gap: null, receipts: [] });
  });
  it("reports exact evicted cursor ranges without unbounded subscriber queues", async () => {
    const journal = new InteractionReceiptJournal(2);
    const wake = vi.fn();
    journal.subscribe(wake);
    for (let i = 0; i < 5; i++) journal.publish(draft);
    expect(wake).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(wake).toHaveBeenCalledTimes(1);
    expect(journal.read(0)).toMatchObject({ cursor: 5, gap: { from: 1, through: 3 } });
    expect(journal.read(0).receipts.map((r) => r.sequence)).toEqual([4, 5]);
    expect(journal.read(4).gap).toBeNull();
    expect(journal.read(5).receipts).toEqual([]);
  });
  it("does not allocate a cursor for invalid evidence", () => {
    const journal = new InteractionReceiptJournal();
    expect(() => journal.publish({ ...draft, sourceSemanticPaneId: "pane.unverified" })).toThrow();
    expect(journal.read(0).cursor).toBe(0);
  });
  it("does not let callers rewrite retained history", () => {
    const journal = new InteractionReceiptJournal();
    const receipt = journal.publish(draft);
    receipt.target = { kind: "session" };
    const replay = journal.read(0);
    replay.receipts[0]!.target = { kind: "session" };
    expect(journal.read(0).receipts[0]!.target).toEqual(draft.target);
  });
  it("isolates broken subscribers and retires idle subscribers", async () => {
    const journal = new InteractionReceiptJournal();
    const bad = vi.fn(() => {
      throw new Error("broken transport");
    });
    const good = vi.fn();
    journal.subscribe(bad);
    journal.subscribe(good);
    expect(() => journal.publish(draft)).not.toThrow();
    await Promise.resolve();
    journal.publish(draft);
    await Promise.resolve();
    expect(bad).toHaveBeenCalledTimes(1);
    journal.dispose();
    await Promise.resolve();
    expect(good).toHaveBeenCalledTimes(3);
    expect(() => journal.read(0)).toThrow("retired");
    expect(() => journal.publish(draft)).toThrow("retired");
    expect(() => journal.subscribe(good)).toThrow("retired");
    journal.dispose();
  });
  it("bounds subscribers and releases their capacity on unsubscribe", () => {
    const journal = new InteractionReceiptJournal();
    const subscriptions = Array.from({ length: 64 }, () => journal.subscribe(() => {}));
    expect(() => journal.subscribe(() => {})).toThrow("capacity");
    subscriptions[0]!();
    expect(() => journal.subscribe(() => {})).not.toThrow();
    journal.dispose();
  });
  it("rejects cursors from a future or invalid ordering domain", () => {
    const journal = new InteractionReceiptJournal();
    for (const cursor of [-1, 1, NaN, Infinity, 0.5]) expect(() => journal.read(cursor)).toThrow();
    for (const capacity of [0, -1, 4097, Infinity])
      expect(() => new InteractionReceiptJournal(capacity)).toThrow();
  });
});
