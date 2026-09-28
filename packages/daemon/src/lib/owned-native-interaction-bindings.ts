import { randomUUID } from "node:crypto";
import {
  EnvironmentIdSchema,
  InteractionEvidenceSchemaZ,
  InteractionPaneEndpointSchemaZ,
  NativeJournalIdentitySchemaZ,
  NativeOperationIdentitySchemaZ,
  NativeJournalRecordSchemaZ,
  TmuxServerScopeSchemaZ,
  type InteractionEvidence,
  type InteractionPaneEndpoint,
  type NativeJournalIdentity,
  type NativeOperationIdentity,
  type TmuxServerScope,
} from "@tmux-ide/contracts";
import {
  nativeInteractionReference,
  type NativeInteractionProjection,
} from "./native-interaction-projector.ts";

type NativeEndpoint = Extract<InteractionPaneEndpoint, { kind: "native-pane" }>;
type SemanticEndpoint = Extract<InteractionPaneEndpoint, { kind: "pane" }>;
type Command = "send-keys" | "paste-buffer" | "capture-pane" | "send-prefix";
type Role = "viewer" | "authored";
/** Object identity is checked against this authority; copying these fields grants nothing. */
export interface OwnedNativeConnection {
  readonly bindingId: string;
}
export interface OwnedNativeOperation {
  readonly operationId: string;
}
export interface OwnedNativeOperationRequest {
  readonly operationId: string;
  readonly role: Role;
  readonly target: NativeEndpoint;
  /** Exact direct command plan, including repeated kinds (maximum 64). */
  readonly commands: readonly Command[];
  /** Only actual validated credential grants may be supplied by the owner. */
  readonly source: {
    readonly endpoint: SemanticEndpoint;
    readonly bindingId: string;
    readonly agentRunId: string | null;
  } | null;
  readonly connection?: OwnedNativeConnection;
}
export interface OwnedNativeInteractionDecision {
  readonly disposition: "unknown" | "viewer" | "authored";
  readonly evidence: InteractionEvidence;
  /** Private proof for enriching the existing authored receipt; not a new operation result. */
  readonly proof: {
    readonly acknowledgement: NativeOperationIdentity;
    readonly target: NativeEndpoint;
    readonly source: OwnedNativeOperationRequest["source"];
  } | null;
  readonly reason: "unmatched" | "pending-expired" | "overflow" | "retired" | "matched";
}
interface Connection {
  readonly token: OwnedNativeConnection;
  readonly identity: NativeJournalIdentity;
  readonly role: Role;
  closedAt: number | null;
}
interface Permit {
  readonly token: OwnedNativeOperation;
  readonly request: OwnedNativeOperationRequest;
  readonly expiresAt: number;
  readonly completed: Map<string, Command>;
  acknowledgement: NativeOperationIdentity | null;
  connection: Connection | null;
}
interface Pending {
  readonly item: NativeInteractionProjection;
  readonly permit: Permit;
  readonly expiresAt: number;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function bound(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum)
    throw new TypeError("Invalid owned observation bound");
  return result;
}
/** Pure bounded authority. The owner schedules ONE timer at nextExpiryAt and emits expire() results.
 * No state is inferred from pane names, timestamps, PIDs, options or the journal reader's issuer.
 */
export class OwnedNativeInteractionBindings {
  readonly #environmentId: string;
  readonly #serverScope: TmuxServerScope;
  readonly #serverEpoch: string;
  readonly #now: () => number;
  readonly #maxConnections: number;
  readonly #maxPermits: number;
  readonly #maxPending: number;
  readonly #permitMs: number;
  readonly #pendingMs: number;
  readonly #connections = new Map<OwnedNativeConnection, Connection>();
  readonly #permits = new Map<string, Permit>();
  readonly #pending: Pending[] = [];
  #disposed = false;
  constructor(options: {
    environmentId: string;
    serverScope: TmuxServerScope;
    serverEpoch: string;
    now?: () => number;
    maxConnections?: number;
    maxPermits?: number;
    maxPending?: number;
    permitMs?: number;
    pendingMs?: number;
  }) {
    this.#environmentId = EnvironmentIdSchema.parse(options.environmentId);
    this.#serverScope = TmuxServerScopeSchemaZ.parse(options.serverScope);
    this.#serverEpoch = NativeJournalIdentitySchemaZ.parse({
      schemaVersion: 2,
      type: "identity",
      serverEpoch: options.serverEpoch,
      connectionId: "1",
    }).serverEpoch;
    this.#now = options.now ?? (() => performance.now());
    this.#maxConnections = bound(options.maxConnections, 64, 128);
    this.#maxPermits = bound(options.maxPermits, 256, 4096);
    this.#maxPending = bound(options.maxPending, 256, 4096);
    this.#permitMs = bound(options.permitMs, 30_000, 60_000);
    this.#pendingMs = bound(options.pendingMs, 2_000, 10_000);
  }
  get hasPendingOperations(): boolean {
    return this.#permits.size !== 0 || this.#pending.length !== 0;
  }
  get size() {
    return {
      connections: this.#connections.size,
      permits: this.#permits.size,
      pending: this.#pending.length,
    };
  }
  get nextExpiryAt(): number | null {
    if (this.#disposed) return null;
    let deadline = Infinity;
    for (const permit of this.#permits.values()) deadline = Math.min(deadline, permit.expiresAt);
    for (const pending of this.#pending) deadline = Math.min(deadline, pending.expiresAt);
    for (const connection of this.#connections.values())
      if (connection.closedAt !== null)
        deadline = Math.min(deadline, connection.closedAt + this.#permitMs);
    return deadline === Infinity ? null : deadline;
  }
  /** Caller must obtain identity on this exact private executing connection. */
  registerConnection(raw: NativeJournalIdentity, role: Role): OwnedNativeConnection | null {
    const identity = NativeJournalIdentitySchemaZ.parse(raw);
    if (role !== "viewer" && role !== "authored")
      throw new TypeError("Invalid owned connection role");
    if (
      this.#disposed ||
      identity.serverEpoch !== this.#serverEpoch ||
      this.#connections.size >= this.#maxConnections
    )
      return null;
    if (
      [...this.#connections.values()].some((c) => c.identity.connectionId === identity.connectionId)
    )
      return null;
    const token = Object.freeze({ bindingId: randomUUID() });
    this.#connections.set(token, { token, identity: freeze(identity), role, closedAt: null });
    return token;
  }
  admit(raw: OwnedNativeOperationRequest): OwnedNativeOperation | null {
    const id = NativeOperationIdentitySchemaZ.parse({
      schemaVersion: 2,
      type: "operation-identity",
      serverEpoch: this.#serverEpoch,
      connectionId: "1",
      wrapperCommandId: "1",
      operationId: raw.operationId,
    }).operationId;
    const target = InteractionPaneEndpointSchemaZ.parse(raw.target);
    if (
      target.kind !== "native-pane" ||
      !this.#scope(target) ||
      target.serverEpoch !== this.#serverEpoch
    )
      throw new TypeError("Foreign native operation target");
    if (raw.role !== "viewer" && raw.role !== "authored")
      throw new TypeError("Invalid owned operation role");
    if (
      raw.commands.length < 1 ||
      raw.commands.length > 64 ||
      raw.commands.some(
        (c) => !["send-keys", "paste-buffer", "capture-pane", "send-prefix"].includes(c),
      )
    )
      throw new TypeError("Invalid owned operation commands");
    if (raw.role === "viewer" && raw.source !== null)
      throw new TypeError("Viewer is not an agent source");
    if (raw.source) {
      const source = InteractionPaneEndpointSchemaZ.parse(raw.source.endpoint);
      if (source.kind !== "pane") throw new TypeError("Unresolved source binding");
      // Reuse strict actor validation instead of accepting arbitrary binding/run identifiers.
      if (
        !EnvironmentIdSchema.safeParse(raw.source.bindingId).success ||
        (raw.source.agentRunId !== null &&
          !EnvironmentIdSchema.safeParse(raw.source.agentRunId).success)
      )
        throw new TypeError("Invalid source binding identity");
    }
    const connection = raw.connection ? this.#connections.get(raw.connection) : null;
    if (
      raw.connection &&
      (!connection || connection.closedAt !== null || connection.role !== raw.role)
    )
      return null;
    if (raw.role === "viewer" && !connection) return null;
    if (this.#disposed || this.#permits.has(id) || this.#permits.size >= this.#maxPermits)
      return null;
    const token = Object.freeze({ operationId: id });
    const request = freeze({
      ...structuredClone({ ...raw, connection: undefined }),
      target,
      connection: raw.connection,
    });
    this.#permits.set(id, {
      token,
      request,
      expiresAt: this.#now() + this.#permitMs,
      completed: new Map(),
      acknowledgement: null,
      connection: connection ?? null,
    });
    return token;
  }
  acknowledge(
    token: OwnedNativeOperation,
    connectionToken: OwnedNativeConnection,
    raw: NativeOperationIdentity,
  ): readonly OwnedNativeInteractionDecision[] {
    const ack = NativeOperationIdentitySchemaZ.parse(raw);
    const released = [...this.expire()];
    const permit = this.#permits.get(token.operationId),
      connection = this.#connections.get(connectionToken);
    if (
      this.#disposed ||
      !permit ||
      permit.token !== token ||
      !connection ||
      connection.role !== permit.request.role ||
      (connection.closedAt !== null && permit.acknowledgement === null) ||
      ack.operationId !== token.operationId ||
      ack.serverEpoch !== this.#serverEpoch ||
      ack.connectionId !== connection.identity.connectionId ||
      (permit.connection !== null && permit.connection !== connection)
    )
      return released;
    if (permit.acknowledgement && !same(permit.acknowledgement, ack)) return released;
    permit.connection = connection;
    permit.acknowledgement = freeze(ack);
    for (let i = 0; i < this.#pending.length; ) {
      const pending = this.#pending[i]!;
      if (pending.permit !== permit) {
        i++;
        continue;
      }
      this.#pending.splice(i, 1);
      released.push(this.#decide(pending.item, permit));
    }
    this.#retireCompleted();
    return released;
  }
  /** Process a complete projector output batch before retiring completed proof, so all effects
   * from one native command retain the same classification. */
  ingestBatch(
    items: readonly NativeInteractionProjection[],
  ): readonly OwnedNativeInteractionDecision[] {
    const decisions = items.flatMap((item) => this.#ingest(item));
    this.#retireCompleted();
    return decisions;
  }
  ingest(raw: NativeInteractionProjection): readonly OwnedNativeInteractionDecision[] {
    return this.ingestBatch([raw]);
  }
  #ingest(raw: NativeInteractionProjection): readonly OwnedNativeInteractionDecision[] {
    const item = freeze(structuredClone(raw));
    // Invalid public evidence is a producer error, not a reason to invent a replacement record.
    InteractionEvidenceSchemaZ.parse(item.evidence);
    const released = [...this.expire()];
    const correlation = item.native.record.correlation;
    const permit = correlation === null ? undefined : this.#permits.get(correlation);
    if (this.#disposed || !permit || !this.#candidate(item, permit))
      return [...released, this.#unknown(item, "unmatched")];
    if (permit.acknowledgement) return [...released, this.#decide(item, permit)];
    if (this.#pending.length >= this.#maxPending)
      return [...released, this.#unknown(item, "overflow")];
    this.#pending.push({
      item,
      permit,
      expiresAt: Math.min(permit.expiresAt, this.#now() + this.#pendingMs),
    });
    return released;
  }
  expire(): readonly OwnedNativeInteractionDecision[] {
    const now = this.#now(),
      released: OwnedNativeInteractionDecision[] = [];
    for (let i = 0; i < this.#pending.length; ) {
      const pending = this.#pending[i]!;
      if (now < pending.expiresAt) {
        i++;
        continue;
      }
      this.#pending.splice(i, 1);
      released.push(this.#unknown(pending.item, "pending-expired"));
    }
    for (const [id, permit] of this.#permits) if (now >= permit.expiresAt) this.#permits.delete(id);
    for (const [token, connection] of this.#connections) {
      if (
        connection.closedAt !== null &&
        (now >= connection.closedAt + this.#permitMs ||
          ![...this.#permits.values()].some((permit) => permit.connection === connection))
      )
        this.#connections.delete(token);
    }
    return released;
  }
  /** Authored helper exit preserves acknowledged proof until bounded permit expiry.
   * New admissions are denied; viewer closure always retires immediately. */
  closeConnection(token: OwnedNativeConnection): readonly OwnedNativeInteractionDecision[] {
    const connection = this.#connections.get(token);
    if (!connection) return [];
    if (connection.role === "viewer") return this.retireConnection(token);
    connection.closedAt ??= this.#now();
    return this.expire();
  }
  retireConnection(token: OwnedNativeConnection): readonly OwnedNativeInteractionDecision[] {
    const connection = this.#connections.get(token);
    if (!connection) return [];
    this.#connections.delete(token);
    return this.#retire((permit) => permit.connection === connection);
  }
  dispose(): readonly OwnedNativeInteractionDecision[] {
    if (this.#disposed) return [];
    this.#disposed = true;
    this.#connections.clear();
    return this.#retire(() => true);
  }
  #retire(matches: (permit: Permit) => boolean): OwnedNativeInteractionDecision[] {
    const released: OwnedNativeInteractionDecision[] = [];
    for (let i = 0; i < this.#pending.length; ) {
      const pending = this.#pending[i]!;
      if (!matches(pending.permit)) {
        i++;
        continue;
      }
      this.#pending.splice(i, 1);
      released.push(this.#unknown(pending.item, "retired"));
    }
    for (const [id, permit] of this.#permits) if (matches(permit)) this.#permits.delete(id);
    return released;
  }
  #retireCompleted(): void {
    for (const [id, permit] of this.#permits) {
      if (!permit.acknowledgement) continue;
      const remaining = [...permit.request.commands];
      for (const kind of permit.completed.values()) {
        const index = remaining.indexOf(kind);
        if (index >= 0) remaining.splice(index, 1);
      }
      if (remaining.length === 0) this.#permits.delete(id);
    }
    for (const [token, connection] of this.#connections) {
      if (
        connection.closedAt !== null &&
        ![...this.#permits.values()].some((permit) => permit.connection === connection)
      )
        this.#connections.delete(token);
    }
  }
  #scope(endpoint: InteractionPaneEndpoint): boolean {
    return (
      endpoint.environmentId === this.#environmentId &&
      endpoint.serverScope.serverId === this.#serverScope.serverId &&
      endpoint.serverScope.generation === this.#serverScope.generation
    );
  }
  #unknown(
    item: NativeInteractionProjection,
    reason: OwnedNativeInteractionDecision["reason"],
  ): OwnedNativeInteractionDecision {
    return freeze({ disposition: "unknown", evidence: item.evidence, proof: null, reason });
  }
  #candidate(item: NativeInteractionProjection, permit: Permit): boolean {
    const record = NativeJournalRecordSchemaZ.safeParse(item.native.record);
    const evidence = item.evidence,
      observation = evidence.observation,
      destination = evidence.endpoints.destination;
    if (
      !record.success ||
      item.native.uncertainty !== null ||
      item.native.serverEpoch !== this.#serverEpoch ||
      destination.kind !== "native-pane" ||
      !same(destination, permit.request.target) ||
      observation.kind !== "native-journal" ||
      observation.serverEpoch !== this.#serverEpoch ||
      observation.cursor.epoch !== item.native.journalEpoch ||
      observation.cursor.sequence !== record.data.sequence ||
      !permit.request.commands.includes(observation.command as Command)
    )
      return false;
    const r = record.data;
    if (
      r.issuerId === "0" ||
      r.commandId === "0" ||
      r.requestId === "0" ||
      r.transport === 0 ||
      r.derivation !== 1 ||
      r.parentCommandId === "0" ||
      r.correlation !== permit.token.operationId ||
      r.targetBirthId !== destination.paneBirthId
    )
      return false;
    const reference = (category: string, id: string) =>
      nativeInteractionReference([
        this.#environmentId,
        this.#serverScope.serverId,
        this.#serverScope.generation,
        this.#serverEpoch,
        category,
        id,
      ]);
    if (
      evidence.actor.kind !== "native" ||
      evidence.actor.identity !== "connection" ||
      evidence.actor.classification.kind !== "unknown" ||
      evidence.actor.sourceBindingId !== null ||
      evidence.endpoints.source !== null ||
      observation.correlatedOperationId !== null ||
      evidence.actor.issuerId !== reference("issuer", r.issuerId) ||
      observation.commandId !== reference("command", r.commandId) ||
      observation.parentCommandId !== reference("command", r.parentCommandId)
    )
      return false;
    if (permit.connection && r.issuerId !== permit.connection.identity.connectionId) return false;
    const outcome = item.native.commandOutcome;
    if (!outcome || !NativeJournalRecordSchemaZ.safeParse(outcome).success || outcome.kind > 4)
      return false;
    const command =
      outcome.kind === 1
        ? "send-keys"
        : outcome.kind === 2
          ? "capture-pane"
          : outcome.kind === 3
            ? "paste-buffer"
            : "send-prefix";
    if (
      command !== observation.command ||
      outcome.targetBirthId !== destination.paneBirthId ||
      (r.kind <= 4 && r.kind !== outcome.kind)
    )
      return false;
    for (const key of [
      "issuerId",
      "commandId",
      "requestId",
      "parentCommandId",
      "transport",
      "derivation",
      "correlation",
    ] as const)
      if (outcome[key] !== r[key]) return false;
    return r.kind >= 5
      ? r.kind === 5
        ? evidence.effect.kind === "input-enqueued"
        : evidence.effect.kind === "snapshot-produced"
      : evidence.effect.kind === "unknown";
  }
  #decide(item: NativeInteractionProjection, permit: Permit): OwnedNativeInteractionDecision {
    const ack = permit.acknowledgement,
      connection = permit.connection,
      r = item.native.record;
    if (
      !ack ||
      !connection ||
      !this.#connections.has(connection.token) ||
      !this.#candidate(item, permit) ||
      r.issuerId !== ack.connectionId ||
      r.parentCommandId !== ack.wrapperCommandId
    )
      return this.#unknown(item, "unmatched");
    const commandKind =
      item.evidence.observation.kind === "native-journal"
        ? (item.evidence.observation.command as Command)
        : null;
    if (
      commandKind === null ||
      (!permit.completed.has(r.commandId) &&
        [...permit.completed.values()].filter((kind) => kind === commandKind).length >=
          permit.request.commands.filter((kind) => kind === commandKind).length)
    )
      return this.#unknown(item, "unmatched");
    const source = permit.request.source;
    const actor = item.evidence.actor;
    if (actor.kind !== "native") return this.#unknown(item, "unmatched");
    const evidence = InteractionEvidenceSchemaZ.parse({
      ...item.evidence,
      revision: item.evidence.revision + 1,
      endpoints: { ...item.evidence.endpoints, source: source?.endpoint ?? null },
      actor: {
        ...actor,
        sourceBindingId: source?.bindingId ?? null,
        classification:
          permit.request.role === "viewer"
            ? { kind: "viewer", bindingId: connection.token.bindingId }
            : source?.agentRunId
              ? { kind: "agent", bindingId: source.bindingId, agentRunId: source.agentRunId }
              : { kind: "unknown" },
      },
    });
    // Native outcome proves this direct command completed; it does not settle the authored operation.
    const command =
      item.evidence.observation.kind === "native-journal"
        ? (item.evidence.observation.command as Command)
        : null;
    if (
      command !== null &&
      !permit.completed.has(r.commandId) &&
      [...permit.completed.values()].filter((kind) => kind === command).length <
        permit.request.commands.filter((kind) => kind === command).length
    )
      permit.completed.set(r.commandId, command);
    return freeze({
      disposition: permit.request.role,
      evidence,
      proof: { acknowledgement: ack, target: permit.request.target, source },
      reason: "matched",
    });
  }
}
