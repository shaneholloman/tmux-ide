import type {
  InteractionEvidence,
  InteractionObservationGap,
  InteractionObservationStatus,
  NativeJournalCapability,
  NativeJournalIdentity,
  NativeOperationIdentity,
  TmuxServerScope,
} from "@tmux-ide/contracts";
import {
  NativeInteractionProjector,
  type NativeInteractionProjection,
} from "./native-interaction-projector.ts";
import {
  OwnedNativeInteractionBindings,
  type OwnedNativeConnection,
  type OwnedNativeOperation,
  type OwnedNativeOperationRequest,
  type OwnedNativeInteractionDecision,
  type OwnedNativePlanCompletion,
} from "./owned-native-interaction-bindings.ts";
import {
  NativeTmuxInteractionObserver,
  type NativeJournalObserverEvent,
  type NativeTmuxInteractionObserverOptions,
} from "./native-tmux-interaction-observer.ts";
import type { InteractionObservationStatusStore } from "./interaction-observation-status.ts";
import type { WorkspacePaneTmuxAuthority } from "./workspace-pane-creation.ts";
import type { NativeTmuxServerIdentity } from "./tmux-server-generation-runner.ts";
export const nativeInteractionObservationRequested = () =>
  process.env.TMUX_IDE_NATIVE_OBSERVATION === "1";
type Reader = Pick<NativeTmuxInteractionObserver, "start" | "dispose">;
export interface OwnerInteractionObservationOptions {
  readonly environmentId: string;
  readonly serverScope: TmuxServerScope;
  readonly tmuxAuthority: WorkspacePaneTmuxAuthority;
  readonly nativeServerIdentity: NativeTmuxServerIdentity | undefined;
  readonly enabled: boolean;
  readonly status: InteractionObservationStatusStore;
  readonly publishEvidence: (evidence: InteractionEvidence) => void;
  /** True means the exact proof enriched an existing authored receipt instead. */
  readonly onOwnedPlanComplete?: (proof: OwnedNativePlanCompletion) => void;
  readonly publishOwnedEvidence?: (decision: OwnedNativeInteractionDecision) => boolean;
  readonly readerFactory?: (options: NativeTmuxInteractionObserverOptions) => Reader;
}
/** One passive observation owner per generation. Hooks retain their independent authored completion role. */
export class OwnerInteractionObservation {
  readonly #options: OwnerInteractionObservationOptions;
  #selection: "pending" | "stock" | "native";
  #stockAvailable = false;
  #disposed = false;
  #halted = false;
  #disposal: Promise<void> | null = null;
  #reader: Reader | null = null;
  #projector: NativeInteractionProjector | null = null;
  #capability: NativeJournalCapability | null = null;
  #start: Promise<void> | null = null;
  #bindings: OwnedNativeInteractionBindings | null = null;
  #bindingTimer: ReturnType<typeof setTimeout> | null = null;
  #bindingDeadline: number | null = null;
  constructor(options: OwnerInteractionObservationOptions) {
    this.#options = options;
    this.#selection = options.enabled && options.nativeServerIdentity ? "pending" : "stock";
  }
  get nativeServerEpoch(): string | null {
    return !this.#disposed && !this.#halted && this.#selection === "native"
      ? (this.#capability?.serverEpoch ?? null)
      : null;
  }
  get selection() {
    return this.#selection;
  }
  get ownedOperationPaneGuard(): boolean {
    return (
      this.ownedOperationEpochGuard &&
      this.#capability?.ownedOperationPaneGuard === "direct-pane-v1"
    );
  }
  get ownedOperationEpochGuard(): boolean {
    return (
      this.ownedOperationTransport &&
      this.#capability?.ownedOperationEpochGuard === "server-epoch-v1"
    );
  }
  get ownedOperationTransport(): boolean {
    return !this.#disposed && !this.#halted && this.#bindings !== null;
  }
  failOwnedOperationObservation(): void {
    if (this.#disposed || this.#halted) return;
    this.#halted = true;
    this.#retireBindings(false);
    this.#unavailable();
    void this.#reader?.dispose().catch(() => undefined);
  }
  noteOwnedOperationUncertainty(): void {
    if (!this.#disposed && !this.#halted && this.#selection === "native")
      this.#options.status.noteGap("uncertain-consume", 0);
  }
  registerOwnedConnection(identity: NativeJournalIdentity, role: "viewer" | "authored") {
    return this.#withBindings((bindings) => {
      const connection = bindings.registerConnection(identity, role);
      if (!connection) this.#options.status.noteGap("uncertain-consume", 0);
      return connection;
    }, null);
  }
  admitOwnedOperation(request: OwnedNativeOperationRequest): OwnedNativeOperation | null {
    return this.#withBindings((bindings) => {
      this.#decisions(bindings.expire());
      const permit = bindings.admit(request);
      if (!permit) this.#options.status.noteGap("uncertain-consume", 0);
      this.#scheduleBindings();
      return permit;
    }, null);
  }
  acknowledgeOwnedOperation(
    permit: OwnedNativeOperation,
    connection: OwnedNativeConnection,
    acknowledgement: NativeOperationIdentity,
  ): void {
    this.#withBindings((bindings) => {
      this.#decisions(bindings.acknowledge(permit, connection, acknowledgement));
      this.#scheduleBindings();
    }, undefined);
  }
  closeOwnedConnection(connection: OwnedNativeConnection): void {
    this.#withBindings((bindings) => {
      this.#decisions(bindings.closeConnection(connection));
      this.#scheduleBindings();
    }, undefined);
  }
  #withBindings<T>(action: (bindings: OwnedNativeInteractionBindings) => T, fallback: T): T {
    if (!this.ownedOperationTransport) return fallback;
    try {
      return action(this.#bindings!);
    } catch {
      // Metadata publication must never turn an already executed terminal action
      // into a failure that encourages the caller to send it again.
      this.#halted = true;
      this.#retireBindings(false);
      this.#unavailable();
      void this.#reader?.dispose().catch(() => undefined);
      return fallback;
    }
  }
  #decisions(decisions: readonly OwnedNativeInteractionDecision[]) {
    for (const decision of decisions) {
      if (this.#disposed) return;
      if (decision.reason === "overflow" || decision.reason === "pending-expired")
        this.#options.status.noteGap("uncertain-consume", 0);
      if (decision.disposition === "authored" && this.#options.publishOwnedEvidence?.(decision))
        continue;
      this.#options.publishEvidence(decision.evidence);
    }
  }
  #scheduleBindings() {
    const deadline = this.#bindings?.nextExpiryAt ?? null;
    if (deadline === this.#bindingDeadline) return;
    if (this.#bindingTimer) clearTimeout(this.#bindingTimer);
    this.#bindingTimer = null;
    this.#bindingDeadline = deadline;
    if (deadline === null || this.#disposed || this.#halted) return;
    this.#bindingTimer = setTimeout(
      () => {
        this.#bindingTimer = null;
        this.#bindingDeadline = null;
        if (this.#disposed || this.#halted || !this.#bindings) return;
        try {
          this.#decisions(this.#bindings.expire());
          this.#scheduleBindings();
        } catch {
          this.#halted = true;
          this.#retireBindings(false);
          this.#unavailable();
          void this.#reader?.dispose().catch(() => undefined);
        }
      },
      Math.max(0, deadline - performance.now()),
    );
    this.#bindingTimer.unref?.();
  }
  #retireBindings(publish: boolean) {
    if (this.#bindingTimer) clearTimeout(this.#bindingTimer);
    this.#bindingTimer = null;
    this.#bindingDeadline = null;
    const bindings = this.#bindings;
    this.#bindings = null;
    const decisions = bindings?.dispose() ?? [];
    if (publish) this.#decisions(decisions);
  }
  stockAvailable(available: boolean) {
    this.#stockAvailable = available;
    if (!this.#disposed && this.#selection === "stock")
      this.#options.status.setStockAvailable(available);
  }
  stockGap(reason: InteractionObservationGap["reason"], count: number | null = null) {
    if (!this.#disposed && this.#selection !== "native")
      this.#options.status.noteGap(reason, count);
  }
  allowStockPublication(): boolean {
    if (this.#disposed) return false;
    if (this.#selection === "pending") this.#options.status.noteGap("uncertain-consume");
    return this.#selection === "stock";
  }
  start(): Promise<void> {
    return (this.#start ??= this.#initialize());
  }
  async #initialize() {
    if (this.#disposed || this.#selection === "stock") return;
    const factory =
      this.#options.readerFactory ?? ((options) => new NativeTmuxInteractionObserver(options));
    try {
      this.#reader = factory({
        tmuxAuthority: this.#options.tmuxAuthority,
        nativeServerIdentity: this.#options.nativeServerIdentity!,
        enable: true,
        onEvent: (event) => this.#event(event),
      });
      await this.#reader.start();
    } catch {
      if (this.#selection === "native") this.#unavailable();
    }
    if (this.#disposed) return;
    if (this.#selection === "pending") {
      this.#selection = "stock";
      this.#options.status.setStockAvailable(this.#stockAvailable);
      await this.#reader?.dispose();
    }
  }
  #unavailable() {
    const current = this.#options.status.getSnapshot();
    this.#options.status.setNativeStatus({
      ...current,
      method: "unavailable",
      coverage: "unavailable",
      capabilityVersion: null,
      commands: [],
      effects: [],
      cursor: null,
    });
  }
  #ready(capability: NativeJournalCapability, cursor?: InteractionObservationStatus["cursor"]) {
    this.#selection = "native";
    this.#capability = capability;
    if (capability.ownedOperationTransport === "direct-wrapper-v1")
      this.#bindings ??= new OwnedNativeInteractionBindings({
        environmentId: this.#options.environmentId,
        serverScope: this.#options.serverScope,
        serverEpoch: capability.serverEpoch,
        onPlanComplete: this.#options.onOwnedPlanComplete,
      });
    this.#projector ??= new NativeInteractionProjector({
      environmentId: this.#options.environmentId,
      serverScope: this.#options.serverScope,
      serverEpoch: capability.serverEpoch,
    });
    const current = this.#options.status.getSnapshot();
    this.#options.status.setNativeStatus({
      ...current,
      method: "native-journal",
      capabilityVersion: capability.schemaVersion,
      coverage: "declared-capabilities",
      commands: ["send-keys", "capture-pane", "paste-buffer", "send-prefix"],
      effects: ["input-enqueued", "snapshot-produced"],
      cursor: cursor === undefined ? current.cursor : cursor,
    });
  }
  #publish(items: readonly NativeInteractionProjection[]) {
    if (this.#disposed) return;
    if (this.#bindings?.hasPendingOperations) this.#decisions(this.#bindings.ingestBatch(items));
    else
      for (const item of items) {
        if (this.#disposed) return;
        this.#options.publishEvidence(item.evidence);
      }
    this.#scheduleBindings();
  }
  #event(event: NativeJournalObserverEvent) {
    if (this.#disposed || this.#halted || this.#selection === "stock") return;
    try {
      if (event.type === "state") {
        if (event.status === "ready" && event.capability) this.#ready(event.capability);
        else if (this.#selection === "native" && event.status !== "probing") {
          this.#unavailable();
          if (
            [
              "degraded",
              "retired",
              "consumer-failed",
              "unavailable",
              "incompatible",
              "disabled",
            ].includes(event.status)
          ) {
            this.#halted = true;
            this.#retireBindings(true);
          }
        }
        return;
      }
      if (this.#selection !== "native" || !this.#projector) return;
      if (event.type === "reset") {
        this.#bindings?.invalidateCompletionProof();
        this.#publish(this.#projector.reset(event.cursor.journalEpoch));
        this.#options.status.setNativeStatus({
          ...this.#options.status.getSnapshot(),
          cursor: { epoch: event.cursor.journalEpoch, sequence: event.cursor.sequence },
          lastGap: { reason: "epoch-reset", at: new Date().toISOString(), range: null },
          droppedCount: null,
        });
        return;
      }
      if (event.type === "gap") {
        this.#bindings?.invalidateCompletionProof();
        const current = this.#options.status.getSnapshot();
        const count = BigInt(event.missing.through) - BigInt(event.missing.from) + 1n;
        const dropped = current.droppedCount === null ? null : BigInt(current.droppedCount) + count;
        this.#options.status.setNativeStatus({
          ...current,
          lastGap: {
            reason: "native-range-dropped",
            at: new Date().toISOString(),
            range: {
              epoch: event.cursor.journalEpoch,
              from: event.missing.from,
              to: event.missing.through,
            },
          },
          droppedCount:
            dropped === null || dropped > 18446744073709551615n ? null : String(dropped),
        });
        return;
      }
      if (event.batch.degraded !== 0 || event.batch.gap !== null)
        this.#bindings?.invalidateCompletionProof();
      this.#publish(this.#projector.consume(event.batch));
      const cursor: InteractionObservationStatus["cursor"] = {
        epoch: event.batch.journalEpoch,
        sequence: event.batch.next,
      };
      if (this.#capability) this.#ready(this.#capability, cursor);
    } catch (error) {
      this.#halted = true;
      this.#retireBindings(false);
      this.#unavailable();
      // Stop a failing consumer; never switch to a second passive publisher.
      void this.#reader?.dispose().catch(() => undefined);
      throw error;
    }
  }
  dispose(): Promise<void> {
    if (this.#disposal) return this.#disposal;
    this.#disposed = true;
    this.#retireBindings(false);
    return (this.#disposal = (async () => {
      try {
        await this.#reader?.dispose();
      } finally {
        // Retired pending assembly is not new live evidence.
        this.#projector?.dispose();
        this.#projector = null;
      }
    })());
  }
}
