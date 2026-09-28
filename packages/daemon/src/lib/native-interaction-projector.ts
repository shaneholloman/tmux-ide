import { createHash } from "node:crypto";
import {
  EnvironmentIdSchema,
  NativeJournalCursorSchemaZ,
  TmuxServerScopeSchemaZ,
  type InteractionEvidence,
  type InteractionPaneEndpoint,
  type NativeJournalBatch,
  type NativeJournalCursor,
  type NativeJournalRecord,
  type TmuxServerScope,
} from "@tmux-ide/contracts";

import { parseNativeJournalBatch } from "./native-journal-validation.ts";

export type NativeProjectionUncertainty =
  | "zero-command-id"
  | "retention-gap"
  | "epoch-reset"
  | "assembly-overflow"
  | "caught-up-incomplete"
  | "metadata-mismatch"
  | "degraded"
  | "disposed";
export interface NativeInteractionProjection {
  readonly evidence: InteractionEvidence;
  /** Private metadata for later owned-connection validation; never publish this as a public endpoint. */
  readonly native: {
    readonly serverEpoch: string;
    readonly journalEpoch: string;
    readonly record: NativeJournalRecord;
    readonly commandOutcome: NativeJournalRecord | null;
    readonly uncertainty: NativeProjectionUncertainty | null;
  };
}
export interface NativeInteractionProjectorOptions {
  readonly environmentId: string;
  readonly serverScope: TmuxServerScope;
  readonly serverEpoch: string;
  readonly cursor?: NativeJournalCursor;
  readonly maxPendingRecords?: number;
  readonly now?: () => Date;
}
/** Deterministic UUIDv8 references; zero native IDs are never passed here as identity. */
export function nativeInteractionReference(scope: readonly string[]): string {
  const bytes = createHash("sha256")
    .update(JSON.stringify(["tmux-ide-native-reference-v1", ...scope]))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 128;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const sameContext = (a: NativeJournalRecord, b: NativeJournalRecord) =>
  a.issuerId === b.issuerId &&
  a.requestId === b.requestId &&
  a.parentCommandId === b.parentCommandId &&
  a.transport === b.transport &&
  a.derivation === b.derivation &&
  a.correlation === b.correlation;
const commandName = (
  kind: number,
): "send-keys" | "capture-pane" | "paste-buffer" | "send-prefix" | "unknown" =>
  kind === 1
    ? "send-keys"
    : kind === 2 || kind === 6
      ? "capture-pane"
      : kind === 3
        ? "paste-buffer"
        : kind === 4
          ? "send-prefix"
          : "unknown";

/** Fixed storage, sequence replay fencing, no actor/source/placement guessing. */
export class NativeInteractionProjector {
  readonly #environmentId: string;
  readonly #serverScope: TmuxServerScope;
  readonly #serverEpoch: string;
  readonly #options: NativeInteractionProjectorOptions;
  readonly #limit: number;
  readonly #pending = new Map<string, NativeJournalRecord[]>();
  #pendingCount = 0;
  #journalEpoch: string | null = null;
  #last = 0n;
  #disposed = false;
  constructor(options: NativeInteractionProjectorOptions) {
    this.#options = { ...options };
    this.#environmentId = EnvironmentIdSchema.parse(options.environmentId);
    this.#serverScope = TmuxServerScopeSchemaZ.parse(options.serverScope);
    const cursor = NativeJournalCursorSchemaZ.parse(
      options.cursor ?? {
        serverEpoch: options.serverEpoch,
        journalEpoch: options.serverEpoch,
        sequence: "0",
      },
    );
    if (cursor.serverEpoch !== options.serverEpoch)
      throw new TypeError("Foreign native projector cursor");
    this.#serverEpoch = cursor.serverEpoch;
    if (options.cursor) {
      this.#journalEpoch = cursor.journalEpoch;
      this.#last = BigInt(cursor.sequence);
    }
    this.#limit = options.maxPendingRecords ?? 256;
    if (!Number.isSafeInteger(this.#limit) || this.#limit < 1 || this.#limit > 1024)
      throw new TypeError("Invalid native assembly bound");
  }
  get pendingRecords(): number {
    return this.#pendingCount;
  }
  #reference(...parts: string[]): string {
    return nativeInteractionReference([
      this.#environmentId,
      this.#serverScope.serverId,
      this.#serverScope.generation,
      this.#serverEpoch,
      ...parts,
    ]);
  }
  #destination(record: NativeJournalRecord, interactionId: string): InteractionPaneEndpoint {
    if (record.flags & 1 && record.targetBirthId !== "0")
      return {
        kind: "native-pane",
        environmentId: this.#environmentId,
        serverScope: { ...this.#serverScope },
        serverEpoch: this.#serverEpoch,
        paneBirthId: record.targetBirthId,
      };
    return {
      kind: "unresolved-pane",
      environmentId: this.#environmentId,
      serverScope: { ...this.#serverScope },
      observationRef: this.#reference("destination", interactionId),
    };
  }
  #project(
    record: NativeJournalRecord,
    command: NativeJournalRecord | null,
    uncertainty: NativeProjectionUncertainty | null,
  ): NativeInteractionProjection {
    const journalEpoch = this.#journalEpoch!;
    const interactionId = this.#reference("interaction", journalEpoch, record.sequence);
    const origin = command ?? record;
    const commandId =
      origin.commandId === "0" ? null : this.#reference("command", origin.commandId);
    // All identity inputs are validated at construction/ingestion. Keep the
    // generated shape typed here; the publication journal remains the strict
    // external ingestion boundary rather than parsing this tree twice.
    const receivedAt = Date.prototype.toISOString.call(this.#options.now?.() ?? new Date());
    // Wire timestamps require four-digit years; Date also permits extended years.
    if (receivedAt.length !== 24) throw new RangeError("Unsupported observation timestamp");
    const evidence = {
      schemaVersion: 1,
      interactionId,
      revision: 0,
      endpoints: { destination: this.#destination(record, interactionId), source: null },
      actor:
        origin.issuerId === "0"
          ? { kind: "unknown", reason: "unavailable" }
          : {
              kind: "native",
              issuerId: this.#reference("issuer", origin.issuerId),
              identity: "connection",
              sourceBindingId: null,
              classification: { kind: "unknown" },
            },
      observation: {
        kind: "native-journal",
        serverEpoch: this.#serverEpoch,
        command: commandName(command?.kind ?? record.kind),
        cursor: { epoch: journalEpoch, sequence: record.sequence },
        commandId,
        parentCommandId:
          origin.parentCommandId === "0"
            ? null
            : this.#reference("command", origin.parentCommandId),
        correlatedOperationId: null,
      },
      effect:
        record.kind === 5
          ? { kind: "input-enqueued" }
          : record.kind === 6
            ? { kind: "snapshot-produced" }
            : { kind: "unknown" },
      occurredAt: null,
      timeBasis: "unknown",
      receivedAt,
    } satisfies InteractionEvidence;
    return {
      evidence,
      native: {
        serverEpoch: this.#serverEpoch,
        journalEpoch,
        record,
        commandOutcome: command,
        uncertainty,
      },
    };
  }
  #flushCommand(id: string, reason: NativeProjectionUncertainty): NativeInteractionProjection[] {
    const records = this.#pending.get(id) ?? [];
    this.#pending.delete(id);
    this.#pendingCount -= records.length;
    return records.map((record) => this.#project(record, null, reason));
  }
  flush(reason: NativeProjectionUncertainty): NativeInteractionProjection[] {
    const result: NativeInteractionProjection[] = [];
    for (const id of this.#pending.keys()) result.push(...this.#flushCommand(id, reason));
    return result;
  }
  reset(journalEpoch: string): NativeInteractionProjection[] {
    if (this.#disposed) throw new Error("Native projector disposed");
    const next = NativeJournalCursorSchemaZ.parse({
      serverEpoch: this.#serverEpoch,
      journalEpoch,
      sequence: "0",
    });
    if (journalEpoch === this.#journalEpoch) return [];
    const result = this.flush("epoch-reset");
    this.#journalEpoch = next.journalEpoch;
    this.#last = 0n;
    return result;
  }
  consume(input: NativeJournalBatch): NativeInteractionProjection[] {
    if (this.#disposed) throw new Error("Native projector disposed");
    const batch = parseNativeJournalBatch(input);
    const oldest = BigInt(batch.oldest),
      newest = BigInt(batch.newest);
    if (
      oldest > newest + 1n ||
      BigInt(batch.next) > newest ||
      (batch.gap &&
        (BigInt(batch.gap.from) > BigInt(batch.gap.through) ||
          BigInt(batch.gap.through) !== oldest - 1n))
    )
      throw new Error("Invalid native projection range");
    let previous: bigint | null = null;
    for (const record of batch.records) {
      const sequence = BigInt(record.sequence);
      if (
        sequence < oldest ||
        sequence > newest ||
        (previous !== null && sequence !== previous + 1n)
      )
        throw new Error("Invalid native projection ordering");
      previous = sequence;
    }
    if (previous !== null && previous !== BigInt(batch.next))
      throw new Error("Invalid native projection cursor");

    if (batch.serverEpoch !== this.#serverEpoch) throw new Error("Foreign native projector server");
    if (this.#journalEpoch === null) this.#journalEpoch = batch.journalEpoch;
    if (this.#journalEpoch !== batch.journalEpoch)
      throw new Error("Native journal reset must be explicit");
    const result: NativeInteractionProjection[] = [];
    if (batch.gap && BigInt(batch.gap.through) > this.#last)
      result.push(...this.flush("retention-gap"));
    for (const record of batch.records) {
      Object.freeze(record);
      const sequence = BigInt(record.sequence);
      if (sequence <= this.#last) continue;
      if (sequence !== this.#last + 1n) result.push(...this.flush("retention-gap"));
      this.#last = sequence;
      if (record.kind >= 5) {
        if (record.commandId === "0") {
          result.push(this.#project(record, null, "zero-command-id"));
          continue;
        }
        while (this.#pendingCount >= this.#limit)
          result.push(
            ...this.#flushCommand(this.#pending.keys().next().value!, "assembly-overflow"),
          );
        const pending = this.#pending.get(record.commandId) ?? [];
        pending.push(record);
        this.#pending.set(record.commandId, pending);
        this.#pendingCount++;
        continue;
      }
      const effects = record.commandId === "0" ? [] : (this.#pending.get(record.commandId) ?? []);
      if (!effects.length) {
        result.push(
          this.#project(record, record, record.commandId === "0" ? "zero-command-id" : null),
        );
        continue;
      }
      if (
        effects.some(
          (effect) =>
            !sameContext(effect, record) ||
            (record.kind === 2 ? effect.kind !== 6 : effect.kind !== 5),
        )
      ) {
        result.push(...this.#flushCommand(record.commandId, "metadata-mismatch"));
        result.push(this.#project(record, record, "metadata-mismatch"));
        continue;
      }
      this.#pending.delete(record.commandId);
      this.#pendingCount -= effects.length;
      for (const effect of effects) result.push(this.#project(effect, record, null));
    }
    if (batch.degraded) result.push(...this.flush("degraded"));
    else if (batch.next === batch.newest) result.push(...this.flush("caught-up-incomplete"));
    return result;
  }
  dispose(): NativeInteractionProjection[] {
    if (this.#disposed) return [];
    const pending = this.flush("disposed");
    this.#disposed = true;
    return pending;
  }
}
