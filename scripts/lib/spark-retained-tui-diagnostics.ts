/** Private bounded failure evidence; public metadata never contains frame/error text. */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

type Phase = "baseline" | "forward-loss" | "reconnect" | "replacement" | "cleanup";
type Side = "local" | "remote" | null;
type Checkpoint =
  | "baseline"
  | "admission"
  | "home-frame"
  | "terminal-frame"
  | "identity"
  | "output-action"
  | "output-frame"
  | "input-frame"
  | "forward-discovery"
  | "forward-loss"
  | "reconnect"
  | "replacement"
  | "cleanup";
export class RetainedTuiDeadline extends Error {
  override name = "TimeoutError";
  constructor() {
    super("Retained TUI deadline");
  }
}
export function createRetainedTuiDiagnostics(
  root: string,
  frames: () => Array<{
    side: Exclude<Side, null>;
    frame: string;
    parsed: number;
    bytes: number;
    exited: boolean;
  }>,
) {
  let phase: Phase = "baseline";
  let checkpoint: Checkpoint = "baseline";
  let side: Side = null;
  let failure: {
    phase: Phase;
    checkpoint: Checkpoint;
    side: Side;
    code: string;
    privateFrames: boolean;
  } | null = null;
  return {
    phase(value: Phase) {
      phase = value;
    },
    checkpoint(value: Checkpoint, client: Side = null) {
      checkpoint = value;
      side = client;
    },
    fail(error: unknown) {
      if (failure) return;
      const code =
        error instanceof RetainedTuiDeadline
          ? "deadline"
          : error instanceof Error && error.name === "AbortError"
            ? "cancelled"
            : error instanceof assert.AssertionError
              ? "assertion"
              : "unknown";
      failure = { phase, checkpoint, side, code, privateFrames: false };
      try {
        const captured = frames()
          .slice(0, 2)
          .map((entry) => ({
            side: entry.side,
            frame: Buffer.from(entry.frame).subarray(0, 16380).toString("utf8"),
            truncated: Buffer.byteLength(entry.frame) > 16380,
            parsed: entry.parsed,
            bytes: entry.bytes,
            exited: entry.exited,
          }));
        writeFileSync(
          join(root, "failure-frames.json"),
          JSON.stringify({ version: 1, phase, checkpoint, side, frames: captured }),
          { mode: 0o600, flag: "wx" },
        );
        failure.privateFrames = true;
      } catch {
        /* Preserve the original failure and report missing private evidence. */
      }
    },
    report: () => (failure ? { ...failure } : null),
  };
}
