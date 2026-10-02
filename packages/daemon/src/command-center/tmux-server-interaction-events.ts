import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import {
  TMUX_INTERACTION_BATCH_LIMIT,
  TmuxServerInteractionEventSchemaZ,
  type TmuxServerScope,
  type TmuxServerInteractionEvent,
} from "@tmux-ide/contracts";
import type { InteractionObservationStatusStore } from "../lib/interaction-observation-status.ts";
import type { InteractionReceiptJournal } from "../lib/interaction-receipt-journal.ts";

/** A bounded reader of the owner's retained journal, never a per-client event queue. */
export function streamTmuxInteractions(
  c: Context,
  server: TmuxServerScope,
  journal: InteractionReceiptJournal,
  after: number,
  assertCurrent: () => void,
  observation: InteractionObservationStatusStore,
): Response {
  // Invalid/future cursors fail before the SSE response starts.
  try {
    journal.read(after);
  } catch (error) {
    if (error instanceof RangeError)
      throw new TypeError("Invalid owner receipt cursor", { cause: error });
    throw error;
  }
  return streamSSE(c, async (stream) => {
    let stopped = false;
    let wake: (() => void) | null = null;
    let dirty = true;
    let cursor = after;
    let writing = false;
    const notify = () => {
      if (writing) {
        try {
          assertCurrent();
          journal.read(cursor);
        } catch {
          stopped = true;
          stream.abort();
        }
      }
      dirty = true;
      wake?.();
    };
    stream.onAbort(() => {
      stopped = true;
      notify();
    });
    const unsubscribe = journal.subscribe(notify);
    let unsubscribeStatus: () => void;
    try {
      unsubscribeStatus = observation.subscribe(notify);
    } catch (error) {
      unsubscribe();
      throw error;
    }
    const write = async (frame: TmuxServerInteractionEvent) => {
      const data = JSON.stringify(TmuxServerInteractionEventSchemaZ.parse(frame));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        writing = true;
        await Promise.race([
          stream.writeSSE({ data }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              stream.abort();
              reject(new Error("Slow receipt stream"));
            }, 30_000);
          }),
        ]);
      } finally {
        writing = false;
        clearTimeout(timer);
      }
    };
    try {
      assertCurrent();
      const initialStatus = observation.getSnapshot();
      let statusFingerprint = JSON.stringify(initialStatus);
      await write({ version: 1, server, type: "ready", after, observationStatus: initialStatus });
      while (!stopped) {
        dirty = false;
        assertCurrent();
        const status = observation.getSnapshot();
        const nextFingerprint = JSON.stringify(status);
        if (nextFingerprint !== statusFingerprint) {
          await write({ version: 1, server, type: "status", observationStatus: status });
          statusFingerprint = nextFingerprint;
          continue;
        }
        const replay = journal.read(cursor);
        const receipts = replay.receipts.slice(0, TMUX_INTERACTION_BATCH_LIMIT);
        if (receipts.length) {
          const next = receipts.at(-1)!.sequence;
          await write({
            version: 1,
            server,
            type: "batch",
            after: cursor,
            cursor: next,
            gap: replay.gap,
            receipts,
          });
          cursor = next;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
          if (dirty || stopped) resolve();
        });
        wake = null;
      }
    } catch {
      if (!stopped) await write({ version: 1, server, type: "retired" }).catch(() => undefined);
    } finally {
      unsubscribe();
      unsubscribeStatus();
    }
  });
}
