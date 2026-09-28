import { randomUUID } from "node:crypto";
import type { NativePaneIdentity, TmuxServerScope } from "@tmux-ide/contracts";
import type { OwnerInteractionObservation } from "./owner-interaction-observation.ts";
import type { WorkspaceTmuxAsyncRunOptions } from "./workspace-pane-creation.ts";
import {
  nativeOperationWrapperArgs,
  supportsNativeSessionGuard,
  type NativeOperationSessionGuard,
} from "./native-operation-command.ts";
import { decodeNativeOperationInvocation } from "./native-operation-reply.ts";

export interface BackgroundNativeCaptureRequest {
  readonly paneId: string;
  readonly nativeIdentity: NativePaneIdentity | null;
  readonly sessionGuard?: NativeOperationSessionGuard;
  readonly mode: "agent-status" | "fleet-preview";
}
/** One passive capture, never an attach or automation operation. null proves no dispatch. */
export function createBackgroundNativeCapture(options: {
  readonly environmentId: string;
  readonly serverScope: TmuxServerScope;
  readonly observation: () => OwnerInteractionObservation | null;
  readonly runPinnedTmux: (
    args: readonly string[],
    signal?: AbortSignal,
    options?: WorkspaceTmuxAsyncRunOptions,
  ) => Promise<string>;
}) {
  return async (
    request: BackgroundNativeCaptureRequest,
    signal?: AbortSignal,
  ): Promise<{ output: string } | null> => {
    signal?.throwIfAborted();
    const observer = options.observation(),
      native = request.nativeIdentity ? { ...request.nativeIdentity } : null;
    if (
      !observer?.ownedOperationTransport ||
      !observer.ownedOperationPaneGuard ||
      !native ||
      native.serverEpoch !== observer.nativeServerEpoch
    )
      return null;
    if (
      request.sessionGuard &&
      (!observer.ownedOperationSessionGuard || !supportsNativeSessionGuard(request.sessionGuard))
    )
      return null;
    if (request.mode !== "agent-status" && request.mode !== "fleet-preview")
      throw new TypeError("Invalid background capture mode");
    const operationId = randomUUID();
    const command = [
      "capture-pane",
      "-p",
      ...(request.mode === "agent-status" ? ["-J"] : []),
      "-t",
      request.paneId,
      "-S",
      request.mode === "agent-status" ? "-20" : "-24",
    ];
    // Serialize and validate the complete guarded plan before reserving capacity.
    const args = [
      "tmux-ide-events",
      "-i",
      ";",
      ...nativeOperationWrapperArgs(
        operationId,
        [command],
        native.serverEpoch,
        { paneId: request.paneId, paneBirthId: native.paneBirthId },
        request.sessionGuard,
      ),
    ];
    const permit = observer.admitOneShotViewerCapture({
      operationId,
      target: {
        kind: "native-pane",
        environmentId: options.environmentId,
        serverScope: options.serverScope,
        ...native,
      },
    });
    if (!permit) return null;
    const uncertain = () => {
      try {
        observer.noteOwnedOperationUncertainty();
      } catch {
        /* Metadata cannot trigger another capture. */
      }
    };
    const cancel = () => {
      try {
        observer.cancelUndispatchedOwnedOperation(permit);
      } catch {
        /* Retire conservatively through owner expiry. */
      }
    };
    const abandon = () => {
      try {
        observer.abandonUnacknowledgedOwnedOperation(permit);
      } catch {
        /* Bounded expiry remains the fallback for ambiguous proof. */
      }
    };
    const observe = (output: string) => {
      const decoded = decodeNativeOperationInvocation(output, {
        serverEpoch: native.serverEpoch,
        operationId,
      });
      try {
        observer.acknowledgeOneShotViewerCapture(permit, decoded.identity, decoded.acknowledgement);
      } catch {
        uncertain();
      }
      if (Buffer.byteLength(decoded.output, "utf8") > 65536)
        throw new Error("Background pane capture output limit exceeded");
      return decoded.output;
    };
    let raw: string;
    let dispatched = false;
    try {
      signal?.throwIfAborted();
      dispatched = true;
      raw = await options.runPinnedTmux(args, signal, {
        preserveTrailingNewlines: true,
        maxOutputBytes: 65536 + 2050,
      });
    } catch (error) {
      if (!dispatched) {
        cancel();
        throw error;
      }
      // Process failures may still carry exact metadata. Never retain the capture tail.
      let candidate = error;
      for (let depth = 0; depth < 2 && candidate && typeof candidate === "object"; depth++) {
        const value = candidate as { stdout?: unknown; cause?: unknown };
        const prefix =
          typeof value.stdout === "string"
            ? value.stdout.slice(0, 2051)
            : Buffer.isBuffer(value.stdout)
              ? value.stdout.subarray(0, 2051).toString("utf8")
              : null;
        if (prefix !== null) {
          const first = prefix.indexOf("\n"),
            second = prefix.indexOf("\n", first + 1);
          if (first >= 0 && second >= 0)
            try {
              observe(prefix.slice(0, second + 1));
            } catch {
              uncertain();
            }
          break;
        }
        candidate = value.cause;
      }
      uncertain();
      abandon();
      // Subprocess causes can contain captured terminal text and private prefixes.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(
        signal?.aborted ? "Background pane capture aborted" : "Background pane capture failed",
      );
    }
    try {
      return { output: observe(raw) };
    } catch {
      uncertain();
      abandon();
      throw new Error("Background pane capture acknowledgement unavailable");
    }
  };
}
