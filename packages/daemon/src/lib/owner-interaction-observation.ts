import type {
  InteractionEvidence,
  InteractionObservationGap,
  InteractionObservationStatus,
  NativeJournalCapability,
  TmuxServerScope,
} from "@tmux-ide/contracts";
import { NativeInteractionProjector } from "./native-interaction-projector.ts";
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
  constructor(options: OwnerInteractionObservationOptions) {
    this.#options = options;
    this.#selection = options.enabled && options.nativeServerIdentity ? "pending" : "stock";
  }
  get selection() {
    return this.#selection;
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
  #ready(capability: NativeJournalCapability) {
    this.#selection = "native";
    this.#capability = capability;
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
      cursor: current.cursor,
    });
  }
  #publish(items: readonly { evidence: InteractionEvidence }[]) {
    for (const item of items) {
      if (this.#disposed) return;
      this.#options.publishEvidence(item.evidence);
    }
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
          )
            this.#halted = true;
        }
        return;
      }
      if (this.#selection !== "native" || !this.#projector) return;
      if (event.type === "reset") {
        this.#publish(this.#projector.reset(event.cursor.journalEpoch));
        this.#options.status.noteGap("epoch-reset");
        return;
      }
      if (event.type === "gap") {
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
      this.#publish(this.#projector.consume(event.batch));
      const current = this.#options.status.getSnapshot();
      const cursor: InteractionObservationStatus["cursor"] = {
        epoch: event.batch.journalEpoch,
        sequence: event.batch.next,
      };
      if (this.#capability) this.#ready(this.#capability);
      this.#options.status.setNativeStatus({
        ...this.#options.status.getSnapshot(),
        cursor,
        lastGap: current.lastGap,
        droppedCount: current.droppedCount,
      });
    } catch (error) {
      this.#halted = true;
      this.#unavailable();
      // Stop a failing consumer; never switch to a second passive publisher.
      void this.#reader?.dispose().catch(() => undefined);
      throw error;
    }
  }
  dispose(): Promise<void> {
    if (this.#disposal) return this.#disposal;
    this.#disposed = true;
    return (this.#disposal = (async () => {
      await this.#reader?.dispose();
      // Retired pending assembly is not new live evidence.
      this.#projector?.dispose();
      this.#projector = null;
    })());
  }
}
