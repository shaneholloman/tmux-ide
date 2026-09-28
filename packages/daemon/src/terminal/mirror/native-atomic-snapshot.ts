import { z } from "zod";
import { NativeJournalUint64SchemaZ } from "@tmux-ide/contracts";
import {
  decodeNativeGridCapture,
  isNativeBootstrapCapture,
  type NativeGridCapture,
} from "./native-grid-capture.ts";
import type { ControlReply } from "./control-channel.ts";
import type { OwnedViewerRequest } from "./owned-viewer-adapter.ts";

export const NATIVE_ATOMIC_SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024;
const MAX_LINES = NATIVE_ATOMIC_SNAPSHOT_MAX_BYTES / 64;
const TargetSchema = z
  .object({
    serverEpoch: z.uuid(),
    paneId: z
      .string()
      .regex(/^%(0|[1-9][0-9]{0,9})$/u)
      .refine((value) => Number(value.slice(1)) <= 4294967295),
    paneBirthId: NativeJournalUint64SchemaZ.refine((value) => value !== "0"),
  })
  .strict();
export type NativeAtomicSnapshotTarget = z.infer<typeof TargetSchema>;
const MetadataSchema = TargetSchema.extend({
  snapshotVersion: z.literal(1),
  cursor: z.string().max(1024),
  resumed: z.literal(true),
}).strict();
export type NativeAtomicSnapshotResult =
  | {
      readonly status: "ok";
      readonly inlineContinue: true;
      readonly capture: NativeGridCapture;
      readonly cursorLine: string;
      readonly target: NativeAtomicSnapshotTarget;
    }
  | { readonly status: "unknown" };
function validLimit(limit: number): boolean {
  return Number.isSafeInteger(limit) && limit > 0 && limit <= NATIVE_ATOMIC_SNAPSHOT_MAX_BYTES;
}
/** One direct child is our admission policy; native Q itself permits other wrapper siblings. */
export function nativeAtomicSnapshotPlan(
  target: NativeAtomicSnapshotTarget,
  maxBytes = NATIVE_ATOMIC_SNAPSHOT_MAX_BYTES,
): OwnedViewerRequest {
  const validated = TargetSchema.parse(target);
  const continuationBytes = `%continue ${validated.paneId}\n`.length;
  if (!validLimit(maxBytes) || maxBytes <= continuationBytes)
    throw new TypeError("Invalid atomic snapshot budget");
  return {
    expectedServerEpoch: validated.serverEpoch,
    paneId: validated.paneId,
    paneBirthId: validated.paneBirthId,
    commands: [
      [
        "capture-pane",
        "-p",
        "-R",
        "-Q",
        "-U",
        String(maxBytes - continuationBytes),
        "-S",
        "-",
        "-t",
        validated.paneId,
      ],
    ],
    resultIndex: 0,
    limits: { maxBytes, maxLines: MAX_LINES },
  };
}
const decimal = (value: string | undefined): number | null =>
  value !== undefined && /^(0|[1-9][0-9]*)$/u.test(value) && Number.isSafeInteger(Number(value))
    ? Number(value)
    : null;
function validModes(line: string, capture: NativeGridCapture): boolean {
  const fields = line.split(" ");
  if (fields.length !== 23) return false;
  const numeric = [0, 1, 2, 3, 14, 15].map((index) => decimal(fields[index]));
  if (numeric.some((value) => value === null)) return false;
  if (
    numeric[0] !== capture.cursor[0] ||
    numeric[1] !== capture.cursor[1] ||
    numeric[2] !== capture.cols ||
    numeric[3] !== capture.rows ||
    numeric[4] !== capture.history ||
    numeric[5] !== capture.limit
  )
    return false;
  for (const index of [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 16, 17, 18, 19])
    if (!["0", "1", "unknown"].includes(fields[index]!)) return false;
  const region = fields.slice(20, 22).map((value) => (value === "unknown" ? null : decimal(value)));
  if (
    fields
      .slice(20, 22)
      .some(
        (value, index) =>
          value !== "unknown" && (region[index] === null || region[index]! >= capture.rows),
      )
  )
    return false;
  if (region[0] !== null && region[1] !== null && region[0]! > region[1]!) return false;
  return ["0", "1", "on", "off", "unknown"].includes(fields[22]!);
}
/** Invalid metadata is unknown, never evidence that ordinary -R is unsupported.
 * The verified terminal continue remains inline; callers preserve FIFO/deadline semantics. */
export function decodeNativeAtomicSnapshot(
  reply: ControlReply,
  expected: NativeAtomicSnapshotTarget,
  maxBytes = NATIVE_ATOMIC_SNAPSHOT_MAX_BYTES,
): NativeAtomicSnapshotResult {
  const unknown = { status: "unknown" as const };
  if (
    !reply.ok ||
    !validLimit(maxBytes) ||
    reply.lines.length < 4 ||
    reply.lines.length > MAX_LINES ||
    !TargetSchema.safeParse(expected).success
  )
    return unknown;
  let bytes = 0;
  for (const line of reply.lines) {
    // Control replies are latin1 byte strings; native metadata/grid JSON is ASCII only.
    bytes += line.length + 1;
    if (bytes > maxBytes || /[^\x20-\x7e]/u.test(line)) return unknown;
  }
  try {
    const parsed = MetadataSchema.safeParse(JSON.parse(reply.lines[0]!));
    if (!parsed.success) return unknown;
    const metadata = parsed.data;
    if (
      metadata.serverEpoch !== expected.serverEpoch ||
      metadata.paneId !== expected.paneId ||
      metadata.paneBirthId !== expected.paneBirthId
    )
      return unknown;
    // Native Q emits this notification inside its own child frame. It must be
    // terminal and exact; a separate asynchronous notification proves nothing here.
    if (reply.lines.at(-1) !== `%continue ${expected.paneId}`) return unknown;
    const capture = decodeNativeGridCapture(reply.lines.slice(1, -1).join("\n") + "\n");
    if (!capture || !isNativeBootstrapCapture(capture) || !validModes(metadata.cursor, capture))
      return unknown;
    return {
      status: "ok",
      inlineContinue: true,
      capture,
      cursorLine: metadata.cursor,
      target: Object.freeze({ ...expected }),
    };
  } catch {
    return unknown;
  }
}
