import { z } from "zod";

/** Native metadata wire, never a public pane/actor identity by itself. */
export const NativeJournalUint64SchemaZ = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,19})$/u)
  .refine(
    (value) => /^(0|[1-9][0-9]{0,19})$/u.test(value) && BigInt(value) <= 18446744073709551615n,
    "uint64 overflow",
  );
const positive = NativeJournalUint64SchemaZ.refine((value) => value !== "0");
export const NATIVE_JOURNAL_COVERAGE = [
  "command-outcome-v1",
  "pty-enqueue-v1",
  "capture-produced-v1",
  "cooperative-operation-v1",
  "pane-identity-v1",
] as const;
export const NativeJournalCapabilitySchemaZ = z
  .object({
    schemaVersion: z.literal(2),
    type: z.literal("capability"),
    readerTransport: z.literal("sessionless-control-v1").optional(),
    ownedOperationTransport: z.literal("direct-wrapper-v1").optional(),
    ownedOperationEpochGuard: z.literal("server-epoch-v1").optional(),
    ownedOperationPaneGuard: z.literal("direct-pane-v1").optional(),
    ownedOperationSessionGuard: z.literal("direct-session-v1").optional(),
    atomicPaneSnapshot: z.literal("capture-resume-v1").optional(),
    atomicPaneSnapshotDual: z.literal("capture-resume-dual-v2").optional(),
    serverEpoch: z.uuid(),
    journalEpoch: z.uuid(),
    enabled: z.boolean(),
    coverage: z
      .array(z.enum(NATIVE_JOURNAL_COVERAGE))
      .length(5)
      .refine((items) => new Set(items).size === 5),
    capacity: z.literal(4096),
    maxBatch: z.literal(256),
    maxWaiters: z.literal(4),
    waitingReaders: z.int().min(0).max(4),
    degraded: z.int().min(0).max(31),
  })
  .strict();
export const NativeJournalRecordSchemaZ = z
  .object({
    sequence: positive,
    commandId: NativeJournalUint64SchemaZ,
    issuerId: NativeJournalUint64SchemaZ,
    monotonicUs: NativeJournalUint64SchemaZ,
    count: NativeJournalUint64SchemaZ,
    targetBirthId: NativeJournalUint64SchemaZ,
    targetId: z.int().min(0).max(4294967295),
    kind: z.int().min(1).max(6),
    outcome: z.int().min(1).max(3),
    flags: z.int().min(0).max(63),
    requestId: NativeJournalUint64SchemaZ,
    parentCommandId: NativeJournalUint64SchemaZ,
    transport: z.int().min(0).max(2),
    derivation: z.int().min(0).max(3),
    correlation: z.uuid().nullable(),
  })
  .strict()
  .superRefine((record, context) => {
    if (
      (record.kind <= 4 && record.count !== "0") ||
      (record.kind === 1 && (record.flags & ~31) !== 0) ||
      (record.kind === 2 && (record.flags & ~33) !== 0) ||
      ((record.kind === 3 || record.kind === 4) && (record.flags & ~1) !== 0) ||
      (record.kind >= 5 && (record.flags !== 1 || record.outcome !== 1)) ||
      (!(record.flags & 1) && (record.targetId !== 0 || record.targetBirthId !== "0")) ||
      (record.kind === 5 && record.count === "0")
    )
      context.addIssue({ code: "custom", message: "inconsistent native record" });
  });
export const NativeJournalBatchSchemaZ = z
  .object({
    schemaVersion: z.literal(2),
    type: z.literal("batch"),
    serverEpoch: z.uuid(),
    journalEpoch: z.uuid(),
    oldest: positive,
    newest: NativeJournalUint64SchemaZ,
    gap: z.object({ from: positive, through: positive }).strict().nullable(),
    records: z.array(NativeJournalRecordSchemaZ).max(64),
    next: NativeJournalUint64SchemaZ,
    degraded: z.int().min(0).max(31),
  })
  .strict();
export const NativeJournalResetSchemaZ = z
  .object({
    schemaVersion: z.literal(2),
    type: z.literal("reset"),
    serverEpoch: z.uuid(),
    journalEpoch: z.uuid(),
  })
  .strict();
export const NativeJournalReadSchemaZ = z.union([
  NativeJournalBatchSchemaZ,
  NativeJournalResetSchemaZ,
]);
export const NativeJournalCursorSchemaZ = z
  .object({ serverEpoch: z.uuid(), journalEpoch: z.uuid(), sequence: NativeJournalUint64SchemaZ })
  .strict();
export type NativeJournalCapability = z.infer<typeof NativeJournalCapabilitySchemaZ>;
export type NativeJournalRecord = z.infer<typeof NativeJournalRecordSchemaZ>;
export type NativeJournalBatch = z.infer<typeof NativeJournalBatchSchemaZ>;
export type NativeJournalCursor = z.infer<typeof NativeJournalCursorSchemaZ>;

export const NativeJournalIdentitySchemaZ = z
  .object({
    schemaVersion: z.literal(2),
    type: z.literal("identity"),
    serverEpoch: z.uuid(),
    connectionId: positive,
  })
  .strict();

export type NativeJournalIdentity = z.infer<typeof NativeJournalIdentitySchemaZ>;
