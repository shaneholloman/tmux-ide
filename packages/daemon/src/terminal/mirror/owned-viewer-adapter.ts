import { randomUUID } from "node:crypto";
import type {
  NativeJournalIdentity,
  NativeOperationIdentity,
  TmuxServerScope,
} from "@tmux-ide/contracts";
import type {
  OwnedNativeConnection,
  OwnedNativeOperation,
  OwnedNativeOperationRequest,
} from "../../lib/owned-native-interaction-bindings.ts";
import type {
  ControlReply,
  MirrorChannelIo,
  NativeViewerControlOptions,
  NativeViewerControlRequest,
} from "./control-channel.ts";

export interface OwnedViewerAuthority {
  readonly environmentId: string;
  readonly serverScope: TmuxServerScope;
  /** Null until all wrapper, epoch and physical pane guards are verified. */
  capability(): { serverEpoch: string; atomicPaneSnapshot?: boolean } | null;
  subscribeReady?: (listener: () => void) => () => void;
  register(identity: NativeJournalIdentity): OwnedNativeConnection | null;
  admit(request: OwnedNativeOperationRequest): OwnedNativeOperation | null;
  acknowledge(
    permit: OwnedNativeOperation,
    connection: OwnedNativeConnection,
    ack: NativeOperationIdentity,
  ): void;
  cancelUndispatched(permit: OwnedNativeOperation): void;
  close(connection: OwnedNativeConnection): void;
  uncertain(): void;
}
export type OwnedViewerRequest = Omit<
  NativeViewerControlRequest,
  "operationId" | "onAcknowledgement"
> & { readonly expectedServerEpoch?: string };
const commands = new Set(["send-keys", "capture-pane", "paste-buffer", "send-prefix"]);

/** One attached control connection, one owner grant. No polling, journal or retry queue. */
export class OwnedViewerAdapter {
  #io: MirrorChannelIo | null = null;
  #identity: NativeJournalIdentity | null = null;
  #connection: OwnedNativeConnection | null = null;
  #disposed = false;
  constructor(private readonly authority: OwnedViewerAuthority) {}
  bindIo(io: MirrorChannelIo): void {
    if (this.#disposed || (this.#io !== null && this.#io !== io))
      throw new Error("Viewer adapter cannot change control connection");
    this.#io = io;
  }
  subscribeReady(listener: () => void): () => void {
    return this.authority.subscribeReady?.(listener) ?? (() => {});
  }
  controlOptions(): NativeViewerControlOptions | undefined {
    let capability: { serverEpoch: string } | null;
    try {
      capability = this.authority.capability();
    } catch {
      this.#uncertain();
      return undefined;
    }
    if (this.#disposed || !capability) return undefined;
    return {
      serverEpoch: capability.serverEpoch,
      onIdentity: (identity) => {
        if (
          this.#disposed ||
          !this.#io ||
          this.#connection ||
          identity.serverEpoch !== capability.serverEpoch ||
          this.authority.capability()?.serverEpoch !== identity.serverEpoch
        )
          return false;
        const connection = this.authority.register(identity);
        if (!connection) return false;
        if (this.#disposed) {
          this.authority.close(connection);
          return false;
        }
        this.#connection = connection;
        this.#identity = { ...identity };
        return true;
      },
      onRetired: () => this.dispose(),
    };
  }
  /** Available only on the actual attached issuer, never the journal reader. */
  atomicSnapshotEpoch(io: MirrorChannelIo): string | null {
    try {
      const capability = this.authority.capability();
      const actual = io.nativeViewerIdentity;
      return !this.#disposed &&
        io === this.#io &&
        this.#connection &&
        this.#identity &&
        capability?.atomicPaneSnapshot === true &&
        actual &&
        actual.connectionId === this.#identity.connectionId &&
        actual.serverEpoch === this.#identity.serverEpoch &&
        capability.serverEpoch === actual.serverEpoch
        ? actual.serverEpoch
        : null;
    } catch {
      this.#uncertain();
      return null;
    }
  }
  tryDispatch(
    io: MirrorChannelIo,
    request: OwnedViewerRequest,
    onReply: (reply: ControlReply) => void,
  ): boolean {
    const identity = this.#identity,
      connection = this.#connection;
    let actual: NativeJournalIdentity | null | undefined;
    let capability: { serverEpoch: string } | null;
    try {
      actual = io.nativeViewerIdentity;
      capability = this.authority.capability();
    } catch {
      this.#uncertain();
      return false;
    }
    if (
      this.#disposed ||
      io !== this.#io ||
      !identity ||
      !connection ||
      !actual ||
      actual.serverEpoch !== identity.serverEpoch ||
      (request.expectedServerEpoch !== undefined &&
        request.expectedServerEpoch !== identity.serverEpoch) ||
      actual.connectionId !== identity.connectionId ||
      capability?.serverEpoch !== identity.serverEpoch ||
      !io.commandNativeViewerInline ||
      !/^%(0|[1-9][0-9]*)$/.test(request.paneId) ||
      !/^[1-9][0-9]*$/.test(request.paneBirthId) ||
      request.commands.length === 0 ||
      request.commands.length > 64 ||
      request.commands.some((argv) => !commands.has(argv[0] ?? ""))
    )
      return false;
    let permit: OwnedNativeOperation | null;
    try {
      permit = this.authority.admit({
        operationId: randomUUID(),
        role: "viewer",
        source: null,
        connection,
        target: {
          kind: "native-pane",
          environmentId: this.authority.environmentId,
          serverScope: this.authority.serverScope,
          serverEpoch: identity.serverEpoch,
          paneBirthId: request.paneBirthId,
        },
        commands: request.commands.map(
          (argv) => argv[0] as OwnedNativeOperationRequest["commands"][number],
        ),
      });
    } catch {
      this.#uncertain();
      return false;
    }
    if (!permit) return false;
    let replied = false;
    const deliver = (reply: ControlReply) => {
      if (replied) return;
      replied = true;
      try {
        onReply(reply);
      } catch {
        /* terminal callback must not cause replay */
      }
    };
    try {
      const dispatched = io.commandNativeViewerInline(
        {
          ...request,
          operationId: permit.operationId,
          onAcknowledgement: (ack) => {
            try {
              this.authority.acknowledge(permit!, connection, ack);
            } catch {
              this.#uncertain();
            }
          },
        },
        (reply) => {
          if (reply.metadataStatus !== "valid") this.#uncertain();
          deliver(reply);
        },
      );
      if (!dispatched) this.authority.cancelUndispatched(permit);
      return dispatched;
    } catch {
      // A throwing transport may have written. Never invite a fallback send.
      this.#uncertain();
      deliver({ ok: false, lines: [] });
      return true;
    }
  }
  #uncertain(): void {
    try {
      this.authority.uncertain();
    } catch {
      /* metadata only */
    }
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const connection = this.#connection;
    this.#connection = null;
    this.#identity = null;
    this.#io = null;
    if (connection)
      try {
        this.authority.close(connection);
      } catch {
        this.#uncertain();
      }
  }
}
