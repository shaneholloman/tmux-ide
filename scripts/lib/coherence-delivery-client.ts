import {
  admitTerminalDeliveryChunk,
  admitTerminalDeliveryEnvelope,
  commitTerminalDelivery,
  completeTerminalDelivery,
  createTerminalDeliveryClientState,
  TerminalDeliveryAssembler,
  type TerminalDeliveryClientState,
} from "../../packages/core/src/terminal-delivery.ts";
import { hashTerminalReplicaSnapshot } from "../../packages/core/src/terminal-replica.ts";
import type {
  TerminalDeliveryAck,
  TerminalDeliveryNegotiationResult,
  TerminalDeliveryServerMessage,
} from "../../packages/contracts/src/index.ts";

/** Qualification consumer: acknowledge only independently reconstructed state. */
export class CoherenceDeliveryClient {
  state: TerminalDeliveryClientState | null = null;
  commits = 0;
  readonly hashes: string[] = [];
  #assembler: TerminalDeliveryAssembler | null = null;
  #heldAck: TerminalDeliveryAck | null = null;
  #hold = false;
  readonly workspace: string;
  readonly pane: string;
  readonly sendAck: (ack: TerminalDeliveryAck) => void;
  constructor(workspace: string, pane: string, sendAck: (ack: TerminalDeliveryAck) => void) {
    this.workspace = workspace;
    this.pane = pane;
    this.sendAck = sendAck;
  }
  negotiate(result: TerminalDeliveryNegotiationResult): void {
    if (!result.accepted) throw new Error(`Delivery negotiation refused: ${result.reason}`);
    if (this.state) throw new Error("Unexpected second negotiation");
    this.state = createTerminalDeliveryClientState(result.negotiated, this.workspace, this.pane);
  }
  get acknowledgementHeld(): boolean {
    return this.#heldAck !== null;
  }
  hold(): void {
    this.#hold = true;
  }
  release(): void {
    this.#hold = false;
    const ack = this.#heldAck;
    this.#heldAck = null;
    if (ack) this.sendAck(ack);
  }
  receive(message: TerminalDeliveryServerMessage): void {
    if (!this.state) throw new Error("Delivery preceded negotiation");
    if (message.type === "terminal.delivery") {
      this.state = admitTerminalDeliveryEnvelope(this.state, message);
      if (this.state.failed) throw new Error("Envelope admission failed");
      this.#assembler = new TerminalDeliveryAssembler(message);
      return;
    }
    if (message.type !== "terminal.delivery.chunk")
      throw new Error(`Delivery fault: ${message.type}`);
    if (!this.#assembler) throw new Error("Chunk without envelope");
    this.state = admitTerminalDeliveryChunk(this.state, message);
    if (this.state.failed) throw new Error("Chunk admission failed");
    this.#assembler.write(message);
    if (this.state.nextChunk !== this.state.inFlight?.chunkCount) return;
    const result = commitTerminalDelivery(
      this.state,
      completeTerminalDelivery(this.state, this.#assembler),
    );
    this.state = result.state;
    this.#assembler = null;
    if (!this.state.canonicalSnapshot) throw new Error("Missing decoded canonical snapshot");
    const hash = hashTerminalReplicaSnapshot(this.state.canonicalSnapshot);
    if (hash !== this.state.appliedHash) throw new Error("Recomputed state hash mismatch");
    this.commits++;
    if (this.hashes.length === 64) this.hashes.shift();
    this.hashes.push(hash);
    if (this.#hold) {
      if (this.#heldAck) throw new Error("Server advanced past an unacknowledged delivery");
      this.#heldAck = result.ack;
    } else this.sendAck(result.ack);
  }
}
