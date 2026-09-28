import { InteractionEvidenceSchemaZ, NativeJournalRecordSchemaZ } from "@tmux-ide/contracts";
import {
  parseNativeJournalResponse,
  parseNativeJournalBatch,
} from "./native-journal-validation.ts";
import { describe, expect, it } from "vitest";
import {
  NativeInteractionProjector,
  nativeInteractionReference,
} from "./native-interaction-projector.ts";
import type { NativeJournalBatch, NativeJournalRecord } from "@tmux-ide/contracts";
const environmentId = "00000000-0000-4000-8000-000000000001";
const generation = "00000000-0000-4000-8000-000000000002";
const serverEpoch = "00000000-0000-4000-8000-000000000003";
const journalEpoch = "00000000-0000-4000-8000-000000000004";
const otherEpoch = "00000000-0000-4000-8000-000000000005";
const serverScope = { serverId: `tmux-server.${"a".repeat(32)}`, generation };
const record = (
  sequence: string,
  kind = 1,
  extra: Partial<NativeJournalRecord> = {},
): NativeJournalRecord => ({
  sequence,
  kind,
  commandId: "9",
  issuerId: "7",
  requestId: "5",
  parentCommandId: "0",
  monotonicUs: "100",
  count: kind === 5 ? "3" : kind === 6 ? "10" : "0",
  targetId: 0,
  targetBirthId: "1",
  outcome: 1,
  flags: 1,
  transport: 1,
  derivation: 0,
  correlation: null,
  ...extra,
});
const batch = (
  records: NativeJournalRecord[],
  extra: Partial<NativeJournalBatch> = {},
): NativeJournalBatch => ({
  schemaVersion: 2,
  type: "batch",
  serverEpoch,
  journalEpoch,
  oldest: "1",
  newest: records.at(-1)?.sequence ?? "0",
  next: records.at(-1)?.sequence ?? "0",
  degraded: 0,
  gap: null,
  records,
  ...extra,
});
const projector = (
  options: Partial<ConstructorParameters<typeof NativeInteractionProjector>[0]> = {},
) =>
  new NativeInteractionProjector({
    environmentId,
    serverScope,
    serverEpoch,
    now: () => new Date("2026-09-28T00:00:00Z"),
    ...options,
  });
describe("bounded native evidence projection", () => {
  it("assembles effects across batch boundaries without duplicate command action", () => {
    const p = projector();
    expect(p.consume(batch([record("1", 5)], { newest: "2" }))).toEqual([]);
    expect(p.pendingRecords).toBe(1);
    const result = p.consume(batch([record("2")]));
    expect(result).toHaveLength(1);
    expect(result[0]!.evidence.effect).toEqual({ kind: "input-enqueued" });
    expect(result[0]!.evidence.observation).toMatchObject({
      command: "send-keys",
      cursor: { epoch: journalEpoch, sequence: "1" },
    });
    expect(p.pendingRecords).toBe(0);
  });
  it("preserves per-pane synchronized effects with the same native command reference", () => {
    const result = projector().consume(
      batch([record("1", 5), record("2", 5, { targetId: 2 }), record("3")]),
    );
    expect(result).toHaveLength(2);
    expect(result[0]!.evidence.interactionId).not.toBe(result[1]!.evidence.interactionId);
    expect(result.map((r) => r.evidence.endpoints.destination.kind)).toEqual([
      "native-pane",
      "native-pane",
    ]);
    expect(result[0]!.evidence.observation).toMatchObject({
      commandId: (result[1]!.evidence.observation as { commandId: string }).commandId,
    });
  });
  it("never groups zero IDs or infers source/viewer/agent identity", () => {
    const result = projector().consume(
      batch([
        record("1", 5, { commandId: "0", issuerId: "0" }),
        record("2", 5, { commandId: "0", issuerId: "0" }),
        record("3", 1, { commandId: "0", issuerId: "0" }),
      ]),
    );
    expect(result).toHaveLength(3);
    expect(new Set(result.map((r) => r.evidence.interactionId)).size).toBe(3);
    expect(result[0]!.evidence.observation).toMatchObject({ command: "unknown", commandId: null });
    expect(result[0]!.evidence.actor).toEqual({ kind: "unknown", reason: "unavailable" });
    expect(result[0]!.evidence.endpoints.source).toBeNull();
  });
  it("reports successful commands without fabricating a no-input cause", () => {
    const result = projector().consume(batch([record("1", 1, { flags: 9 })]));
    expect(result[0]!.evidence.effect).toEqual({ kind: "unknown" });
  });
  it("preserves orphan effect truth while exposing unknown command", () => {
    const result = projector().consume(batch([record("1", 5)]));
    expect(result[0]!.native.uncertainty).toBe("caught-up-incomplete");
    expect(result[0]!.evidence.observation).toMatchObject({ command: "unknown" });
    expect(result[0]!.evidence.effect.kind).toBe("input-enqueued");
  });
  it("preserves send-prefix and capture commands accurately", () => {
    const result = projector().consume(
      batch([
        record("1", 5),
        record("2", 4),
        record("3", 6, { commandId: "10" }),
        record("4", 2, { commandId: "10" }),
      ]),
    );
    expect(
      result.map((r) =>
        r.evidence.observation.kind === "native-journal" ? r.evidence.observation.command : null,
      ),
    ).toEqual(["send-prefix", "capture-pane"]);
    expect(result.map((r) => r.evidence.effect.kind)).toEqual([
      "input-enqueued",
      "snapshot-produced",
    ]);
  });
  it("flushes overflow and epoch reset as incomplete without growing storage", () => {
    const p = projector({ maxPendingRecords: 2 });
    const result = p.consume(
      batch(
        [
          record("1", 5, { commandId: "1" }),
          record("2", 5, { commandId: "2" }),
          record("3", 5, { commandId: "3" }),
        ],
        { newest: "4" },
      ),
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.native.uncertainty).toBe("assembly-overflow");
    expect(p.pendingRecords).toBe(2);
    expect(p.reset(otherEpoch)).toHaveLength(2);
    expect(p.pendingRecords).toBe(0);
    expect(() => p.consume(batch([record("4")]))).toThrow("reset must be explicit");
  });
  it("flushes pending effects across gaps and degradation", () => {
    const p = projector();
    p.consume(batch([record("1", 5)], { newest: "3" }));
    const result = p.consume(
      batch([record("3", 1, { commandId: "10" })], {
        oldest: "3",
        gap: { from: "2", through: "2" },
      }),
    );
    expect(result[0]!.native.uncertainty).toBe("retention-gap");
    const q = projector();
    expect(
      q.consume(batch([record("1", 5)], { degraded: 8, newest: "2" }))[0]!.native.uncertainty,
    ).toBe("degraded");
    expect(q.pendingRecords).toBe(0);
  });
  it("never combines records with mismatched issuer or operation assertion", () => {
    const result = projector().consume(batch([record("1", 5, { issuerId: "8" }), record("2")]));
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.native.uncertainty === "metadata-mismatch")).toBe(true);
  });
  it("does not treat a claimed correlation UUID as owned connection evidence", () => {
    const result = projector().consume(
      batch([
        record("1", 5, { correlation: otherEpoch }),
        record("2", 1, { correlation: otherEpoch }),
      ]),
    );
    expect(result[0]!.native.record.correlation).toBe(otherEpoch);
    expect(result[0]!.evidence.observation).toMatchObject({ correlatedOperationId: null });
    expect(result[0]!.evidence.actor).toMatchObject({
      kind: "native",
      classification: { kind: "unknown" },
    });
  });
  it("fences replay and equal native IDs on different servers", () => {
    const p = projector();
    const input = batch([record("1")]);
    const first = p.consume(input);
    expect(p.consume(input)).toEqual([]);
    const second = projector({
      serverScope: { ...serverScope, serverId: `tmux-server.${"b".repeat(32)}` },
    }).consume(input);
    expect(first[0]!.evidence.interactionId).not.toBe(second[0]!.evidence.interactionId);
    expect(() => p.consume(batch([record("2")], { serverEpoch: otherEpoch }))).toThrow("Foreign");
  });
  it("preserves immutable physical identity across journal reset without semantic placement", () => {
    const p = projector();
    const before = p.consume(batch([record("1")]))[0]!.evidence;
    expect(before.endpoints.destination).toEqual({
      kind: "native-pane",
      environmentId,
      serverScope,
      serverEpoch,
      paneBirthId: "1",
    });
    p.reset(otherEpoch);
    const after = p.consume(batch([record("1")], { journalEpoch: otherEpoch }))[0]!.evidence;
    expect(after.endpoints.destination).toEqual(before.endpoints.destination);
    expect(after.observation).toMatchObject({ serverEpoch, cursor: { epoch: otherEpoch } });
    expect(after.interactionId).not.toBe(before.interactionId);
  });
  it("never confuses recycled numeric pane IDs or unknown birth identity", () => {
    const p = projector();
    const rows = p.consume(
      batch([
        record("1"),
        record("2", 1, { targetBirthId: "2" }),
        record("3", 1, { targetBirthId: "0" }),
      ]),
    );
    expect(rows[0]!.evidence.endpoints.destination).not.toEqual(
      rows[1]!.evidence.endpoints.destination,
    );
    expect(rows[2]!.evidence.endpoints.destination.kind).toBe("unresolved-pane");
  });
  it("flushes pending effects at disposal and generates valid stable UUIDv8 references", () => {
    const p = projector();
    p.consume(batch([record("1", 5)], { newest: "2" }));
    expect(p.dispose()[0]!.native.uncertainty).toBe("disposed");
    expect(p.dispose()).toEqual([]);
    expect(() => p.consume(batch([]))).toThrow("disposed");
    expect(nativeInteractionReference(["x"])).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });
  it("rejects malformed ordering before changing replay state", () => {
    const p = projector();
    expect(() => p.consume(batch([record("2"), record("1")], { newest: "2" }))).toThrow("ordering");
    expect(p.consume(batch([record("1")]))).toHaveLength(1);
  });
  it("keeps full uint64 sequence precision across assembly and replay", () => {
    const before = "18446744073709551612";
    const p = projector({ cursor: { serverEpoch, journalEpoch, sequence: before } });
    const input = batch([record("18446744073709551613", 5), record("18446744073709551614")], {
      oldest: before,
    });
    expect(p.consume(input)[0]!.evidence.observation).toMatchObject({
      cursor: { sequence: "18446744073709551613" },
    });
    expect(p.consume(input)).toEqual([]);
  });
});

describe("immutable native batch structural proof", () => {
  const parsed = (value: NativeJournalBatch) => {
    const result = parseNativeJournalResponse(JSON.stringify(value));
    if (result.type !== "batch") throw new Error("Expected batch");
    return result;
  };
  it("reuses only the exact parsed immutable object, not clones or caller freezes", () => {
    const input = parsed(batch([record("1")]));
    expect(parseNativeJournalBatch(input)).toBe(input);
    expect(Object.isFrozen(input)).toBe(true);
    expect(Object.isFrozen(input.records)).toBe(true);
    expect(Object.isFrozen(input.records[0])).toBe(true);
    expect(() => {
      input.records[0]!.issuerId = "999";
    }).toThrow();
    expect(() => {
      input.records.push(record("2"));
    }).toThrow();
    expect(() => {
      input.serverEpoch = otherEpoch;
    }).toThrow();
    const copy = structuredClone(input);
    expect(parseNativeJournalBatch(copy)).not.toBe(copy);
    const fake = Object.freeze({ ...copy, unexpected: true });
    expect(() => parseNativeJournalBatch(fake)).toThrow();
    const badRecord = Object.freeze({
      ...copy,
      records: [Object.freeze({ ...record("1"), issuerId: "18446744073709551616" })],
    });
    expect(() => parseNativeJournalBatch(badRecord)).toThrow();
    expect(() => parseNativeJournalResponse(JSON.stringify(fake))).toThrow();
  });
  it("preserves consumer server, range, order, reset and replay checks for proven shapes", () => {
    expect(() =>
      projector().consume(parsed(batch([record("1")], { serverEpoch: otherEpoch }))),
    ).toThrow("Foreign");
    expect(() => projector().consume(parsed(batch([record("2"), record("1")])))).toThrow(
      "ordering",
    );
    expect(() => projector().consume(parsed(batch([record("1")], { next: "2" })))).toThrow();
    const p = projector();
    const input = parsed(batch([record("1")]));
    expect(p.consume(input)).toHaveLength(1);
    expect(p.consume(input)).toEqual([]);
    expect(() => p.consume(parsed(batch([record("2")], { journalEpoch: otherEpoch })))).toThrow(
      "reset",
    );
    p.dispose();
    expect(() => p.consume(input)).toThrow("disposed");
  });
  it("freezes gap metadata before sharing it and preserves ordinary input isolation", () => {
    const input = parsed(batch([record("3")], { oldest: "3", gap: { from: "1", through: "2" } }));
    expect(Object.isFrozen(input.gap)).toBe(true);
    expect(() => {
      input.gap!.from = "0";
    }).toThrow();
    const untrusted = batch([record("1", 5)], { newest: "2" });
    const p = projector();
    p.consume(untrusted);
    untrusted.records[0]!.issuerId = "999";
    const result = p.consume(batch([record("2")]));
    expect(result[0]!.native.uncertainty).toBeNull();
    expect(result[0]!.native.record.issuerId).toBe("7");
  });
});

describe("constructed native evidence schema conformance", () => {
  it("conforms across all record kinds, valid flags/outcomes, zero/max identities and degradation", () => {
    let cases = 0;
    const ids = ["0", "1", "18446744073709551615"];
    for (let kind = 1; kind <= 6; kind++) {
      for (let flags = 0; flags <= 63; flags++) {
        for (let outcome = 1; outcome <= 3; outcome++) {
          for (const id of ids) {
            const candidate = record("1", kind, {
              flags,
              outcome,
              commandId: id,
              issuerId: id,
              requestId: id,
              parentCommandId: id,
              targetBirthId: flags & 1 ? id : "0",
              targetId: flags & 1 ? 4294967295 : 0,
              count: kind >= 5 ? "18446744073709551615" : "0",
              monotonicUs: "18446744073709551615",
              transport: 2,
              derivation: 3,
              correlation: otherEpoch,
            });
            if (!NativeJournalRecordSchemaZ.safeParse(candidate).success) continue;
            for (const degraded of [0, 31]) {
              const projected = projector().consume(batch([candidate], { degraded }));
              expect(projected).toHaveLength(1);
              for (const { evidence } of projected) {
                expect(InteractionEvidenceSchemaZ.parse(evidence)).toEqual(evidence);
                expect(evidence.endpoints.source).toBeNull();
                expect(evidence.observation).toMatchObject({ correlatedOperationId: null });
              }
              cases++;
            }
          }
        }
      }
    }
    expect(cases).toBeGreaterThan(500);
  });
  it("conforms for assembled command/effect pairs and explicit incomplete flushes", () => {
    for (const kind of [1, 2, 3, 4]) {
      const effect = kind === 2 ? 6 : 5;
      const p = projector();
      const results = p.consume(batch([record("1", effect), record("2", kind)]));
      expect(results).toHaveLength(1);
      for (const { evidence } of results)
        expect(InteractionEvidenceSchemaZ.parse(evidence)).toEqual(evidence);
    }
    for (const finish of ["dispose", "reset"] as const) {
      const p = projector();
      expect(p.consume(batch([record("1", 5)], { newest: "2" }))).toEqual([]);
      const results = finish === "dispose" ? p.dispose() : p.reset(otherEpoch);
      for (const { evidence } of results)
        expect(InteractionEvidenceSchemaZ.parse(evidence)).toEqual(evidence);
    }
  });
  it("rejects malformed records and constructor identities before constructing evidence", () => {
    for (const extra of [
      { issuerId: "18446744073709551616" },
      { targetBirthId: "-1" },
      { commandId: "01" },
      { kind: 7 },
      { outcome: 0 },
      { flags: 64 },
      { correlation: "forged" },
      { transport: 3 },
      { derivation: 4 },
      { kind: 5, count: "0" },
      { flags: 0, targetBirthId: "1" },
    ])
      expect(() => projector().consume(batch([record("1", 1, extra)]))).toThrow();
    expect(() => projector({ environmentId: "invalid" })).toThrow();
    expect(() => projector({ serverScope: { ...serverScope, generation: "invalid" } })).toThrow();
    expect(() => projector({ serverEpoch: "invalid" })).toThrow();
  });
  it("emits canonical timestamp years and rejects invalid or extended dates", () => {
    for (const iso of ["0000-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z"]) {
      const result = projector({ now: () => new Date(iso) }).consume(batch([record("1")]));
      expect(InteractionEvidenceSchemaZ.parse(result[0]!.evidence).receivedAt).toBe(iso);
    }
    for (const iso of ["invalid", "+010000-01-01T00:00:00.000Z", "-000001-01-01T00:00:00.000Z"])
      expect(() => projector({ now: () => new Date(iso) }).consume(batch([record("1")]))).toThrow();
  });
  it("does not expose retained authority through generated evidence objects", () => {
    const p = projector();
    const first = p.consume(batch([record("1")]))[0]!.evidence;
    first.endpoints.destination.serverScope.generation = otherEpoch;
    first.actor = { kind: "unknown", reason: "unavailable" };
    const next = p.consume(batch([record("2")]))[0]!.evidence;
    expect(next.endpoints.destination.serverScope).toEqual(serverScope);
    expect(next.actor.kind).toBe("native");
    expect(InteractionEvidenceSchemaZ.parse(next)).toEqual(next);
  });
});
