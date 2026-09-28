import {
  NativeJournalBatchSchemaZ,
  NativeJournalReadSchemaZ,
  type NativeJournalBatch,
} from "@tmux-ide/contracts";

// Identity, not an exported symbol or a caller-provided boolean, carries the proof.
// Entries can enter this set only after strict parsing and recursive freezing.
const immutableBatches = new WeakSet<object>();
function freezeMetadata(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeMetadata(child);
  Object.freeze(value);
}

/** The untrusted native wire boundary. Cursor/owner checks remain with each consumer. */
export function parseNativeJournalResponse(raw: string) {
  const response = NativeJournalReadSchemaZ.parse(JSON.parse(raw));
  if (response.type === "batch") {
    freezeMetadata(response);
    immutableBatches.add(response);
  }
  return response;
}

/** Reuse structural proof only for this module's exact immutable parsed object. */
export function parseNativeJournalBatch(input: NativeJournalBatch): NativeJournalBatch {
  return immutableBatches.has(input) ? input : NativeJournalBatchSchemaZ.parse(input);
}
