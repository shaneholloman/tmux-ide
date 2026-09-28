import type { TmuxServerScope } from "@tmux-ide/contracts";
import type { OwnerInteractionObservation } from "./owner-interaction-observation.ts";
import type { AuthoredNativeCommandRequest } from "./workspace-multiplexer-verbs.ts";
import type { WorkspaceTmuxRunOptions } from "./workspace-pane-creation.ts";
import { nativePaneIdentity } from "./native-pane-identity.ts";
import { nativeOperationWrapperArgs } from "./native-operation-command.ts";
import { decodeNativeOperationInvocation } from "./native-operation-reply.ts";

/** Inspect only bounded private prefixes on a failed invocation, never retain its capture tail. */
function failurePrefix(error: unknown): string | null {
  let candidate = error;
  for (let depth = 0; depth < 2 && candidate && typeof candidate === "object"; depth++) {
    const value = candidate as { stdout?: unknown; cause?: unknown };
    if (typeof value.stdout === "string") {
      const first = value.stdout.indexOf("\n");
      const second = first < 0 ? -1 : value.stdout.indexOf("\n", first + 1);
      return second >= 0 && second <= 2050 ? value.stdout.slice(0, second + 1) : null;
    }
    if (Buffer.isBuffer(value.stdout)) {
      const prefix = value.stdout.subarray(0, 2051).toString("utf8");
      const first = prefix.indexOf("\n"),
        second = prefix.indexOf("\n", first + 1);
      return first >= 0 && second >= 0 ? prefix.slice(0, second + 1) : null;
    }
    candidate = value.cause;
  }
  return null;
}

/** Optional metadata proof around the existing exactly-once execution lane. */
export function createAuthoredNativeCommandRunner(options: {
  readonly environmentId: string;
  readonly serverScope: TmuxServerScope;
  readonly canDispatch?: () => boolean;
  readonly observation: () => OwnerInteractionObservation | null;
  readonly runPinnedTmux: (args: readonly string[], options?: WorkspaceTmuxRunOptions) => string;
}) {
  return (
    request: AuthoredNativeCommandRequest,
    _runOptions?: WorkspaceTmuxRunOptions,
  ): { readonly output: string } | null => {
    if (options.canDispatch && !options.canDispatch()) return null;
    const observer = options.observation();
    if (!observer?.ownedOperationTransport || !observer.ownedOperationPaneGuard) return null;
    const native = nativePaneIdentity(observer.nativeServerEpoch, request.targetBirthId);
    const destination = request.context.interactionContext.destination;
    if (
      !native ||
      destination.kind !== "pane" ||
      destination.environmentId !== options.environmentId ||
      destination.serverScope.serverId !== options.serverScope.serverId ||
      destination.serverScope.generation !== options.serverScope.generation
    )
      return null;
    const source = request.context.interactionContext.source;
    const permit = observer.admitOwnedOperation({
      operationId: request.operationId,
      role: "authored",
      target: {
        kind: "native-pane",
        environmentId: options.environmentId,
        serverScope: options.serverScope,
        ...native,
      },
      authoredDestination: destination,
      commands: request.expectedKinds,
      source: source ? { ...source, agentRunId: null } : null,
    });
    // No native wrapper has been dispatched; the existing stock path may proceed.
    if (!permit) return null;
    const uncertain = () => {
      try {
        observer.noteOwnedOperationUncertainty();
      } catch {
        /* Coverage reporting cannot change a terminal operation result. */
      }
    };
    const expected = { serverEpoch: native.serverEpoch, operationId: request.operationId };
    const observe = (output: string) => {
      const reply = decodeNativeOperationInvocation(output, expected);
      try {
        const connection = observer.registerOwnedConnection(reply.identity, "authored");
        if (connection) {
          try {
            observer.acknowledgeOwnedOperation(permit, connection, reply.acknowledgement);
          } finally {
            observer.closeOwnedConnection(connection);
          }
        }
      } catch {
        uncertain();
        /* Metadata consumers cannot invalidate an already decoded terminal result. */
      }
      return reply.output;
    };
    let output: string;
    try {
      output = options.runPinnedTmux(
        [
          "tmux-ide-events",
          "-i",
          ";",
          ...nativeOperationWrapperArgs(request.operationId, request.commands, native.serverEpoch, {
            paneId: request.targetPaneId,
            paneBirthId: native.paneBirthId,
          }),
        ],
        { preserveTrailingNewlines: true },
      );
    } catch (error) {
      const prefix = failurePrefix(error);
      if (prefix !== null) {
        try {
          observe(prefix);
        } catch {
          uncertain();
          /* Partial effects remain unproven, never retried. */
        }
      } else {
        uncertain();
      }
      throw error;
    }
    try {
      return { output: observe(output) };
    } catch {
      uncertain();
      // Successful input cannot become a retryable error solely because metadata
      // failed. A read must not leak undecoded private prefixes as terminal text.
      if (request.expectedKinds.includes("capture-pane"))
        throw new Error("Native pane snapshot acknowledgement unavailable");
      return { output: "" };
    }
  };
}
