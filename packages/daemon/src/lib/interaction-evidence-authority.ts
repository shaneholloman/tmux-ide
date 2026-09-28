import { randomUUID } from "node:crypto";
import {
  EnvironmentIdSchema,
  InteractionPaneEndpointSchemaZ,
  TmuxServerScopeSchemaZ,
  type InteractionPaneEndpoint,
  type TmuxServerScope,
} from "@tmux-ide/contracts";
import type { PaneSourceBinding } from "./pane-source-credentials.ts";

export interface InteractionInventoryPane {
  readonly workspaceName: string;
  readonly sessionName: string;
  readonly sessionId: string;
  readonly runtimePaneId: string;
  readonly semanticPaneId: string | null;
}
type ResolvedEndpoint = Extract<InteractionPaneEndpoint, { kind: "pane" }>;
interface Binding {
  readonly row: InteractionInventoryPane;
  readonly endpoint: ResolvedEndpoint;
  readonly expiresAt: number;
}
const HISTORY_CAPACITY = 4096;
const HISTORY_MS = 30_000;
const runtimeKey = (row: InteractionInventoryPane) =>
  `${row.sessionId}\0${row.runtimePaneId}\0${row.semanticPaneId}`;
const bindingKey = (row: InteractionInventoryPane) => `${runtimeKey(row)}\0${row.workspaceName}`;

/**
 * One fenced live server owner's private pane-lifetime map. Inventory callbacks
 * must already be generation-validated. No command-time endpoint is inferred by
 * querying today's pane after an observer record arrives.
 */
export class InteractionEvidenceAuthority {
  readonly #environmentId: string;
  readonly #serverScope: TmuxServerScope;
  readonly #now: () => number;
  readonly #live = new Map<string, Binding>();
  readonly #history = new Map<string, Binding>();
  readonly #seen = new Map<string, string>();
  readonly #ambiguous = new Set<string>();
  #observationHistoryExhausted = false;
  #disposed = false;

  constructor(environmentId: string, serverScope: TmuxServerScope, now = Date.now) {
    this.#environmentId = EnvironmentIdSchema.parse(environmentId);
    this.#serverScope = TmuxServerScopeSchemaZ.parse(serverScope);
    this.#now = now;
  }

  #assertOpen(): void {
    if (this.#disposed) throw new Error("Interaction evidence authority is retired");
  }

  /** Full inventory refresh; empty means every previously live binding retires. */
  adoptInventory(rows: readonly InteractionInventoryPane[]): void {
    this.#assertOpen();
    this.#adopt(rows);
  }

  /** Session refresh must not retire independently observed sessions. */
  adoptSessionInventory(sessionName: string, rows: readonly InteractionInventoryPane[]): void {
    this.#assertOpen();
    if (rows.some((row) => row.sessionName !== sessionName))
      throw new TypeError("Foreign session inventory");
    this.#adopt(
      [...this.#live.values()]
        .filter((binding) => binding.row.sessionName !== sessionName)
        .map((binding) => binding.row)
        .concat(rows),
    );
  }

  #adopt(rows: readonly InteractionInventoryPane[]): void {
    const now = this.#now();
    for (const [key, binding] of this.#history)
      if (binding.expiresAt <= now) this.#history.delete(key);
    // Bounded failure is absence of authority, never truncation into an
    // apparently unique semantic identity.
    if (rows.length > HISTORY_CAPACITY) {
      this.#live.clear();
      this.#history.clear();
      this.#observationHistoryExhausted = true;
      return;
    }
    const next = new Map<string, Binding>();
    const lifetimes = new Map(
      [...this.#live.values()].map((binding) => [
        `${binding.row.runtimePaneId}\0${binding.row.semanticPaneId}`,
        binding.endpoint.paneLifetimeId,
      ]),
    );
    for (const row of rows) {
      if (
        !/^\$(?:0|[1-9][0-9]*)$/u.test(row.sessionId) ||
        !/^%(?:0|[1-9][0-9]*)$/u.test(row.runtimePaneId) ||
        !row.semanticPaneId
      )
        continue;
      const lifetimeKey = `${row.runtimePaneId}\0${row.semanticPaneId}`;
      const paneLifetimeId = lifetimes.get(lifetimeKey) ?? randomUUID();
      const result = InteractionPaneEndpointSchemaZ.safeParse({
        kind: "pane",
        environmentId: this.#environmentId,
        serverScope: this.#serverScope,
        paneLifetimeId,
        workspaceName: row.workspaceName,
        semanticPaneId: row.semanticPaneId,
      });
      if (!result.success || result.data.kind !== "pane") continue;
      lifetimes.set(lifetimeKey, paneLifetimeId);
      const binding = { row: { ...row }, endpoint: result.data, expiresAt: now + HISTORY_MS };
      const observationKey = runtimeKey(row);
      const endpointIdentity = JSON.stringify(binding.endpoint);
      const seen = this.#seen.get(observationKey);
      if (seen !== undefined && seen !== endpointIdentity) this.#ambiguous.add(observationKey);
      if (!this.#seen.has(observationKey)) {
        if (this.#seen.size >= HISTORY_CAPACITY) this.#observationHistoryExhausted = true;
        else this.#seen.set(observationKey, endpointIdentity);
      }
      next.set(bindingKey(row), binding);
    }
    for (const [key, binding] of this.#live) {
      if (!next.has(key)) this.#history.set(key, { ...binding, expiresAt: now + HISTORY_MS });
    }
    this.#live.clear();
    for (const [key, binding] of next) this.#live.set(key, binding);
    while (this.#history.size > HISTORY_CAPACITY)
      this.#history.delete(this.#history.keys().next().value!);
  }

  captureAuthoredEndpoint(workspaceName: string, semanticPaneId: string): ResolvedEndpoint | null {
    this.#assertOpen();
    const candidates = [...this.#live.values()].filter(
      (binding) =>
        binding.row.workspaceName === workspaceName &&
        binding.row.semanticPaneId === semanticPaneId,
    );
    if (candidates.length !== 1) return null;
    return structuredClone(candidates[0]!.endpoint);
  }

  /** Requires the hook's immutable session id and semantic stamp, not a late lookup. */
  captureObservedEndpoint(record: {
    runtimePaneId: string;
    sessionId: string;
    semanticPaneId: string;
  }): InteractionPaneEndpoint {
    this.#assertOpen();
    const key = `${record.sessionId}\0${record.runtimePaneId}\0${record.semanticPaneId}`;
    const candidates = new Map<string, Binding>();
    for (const binding of [...this.#history.values(), ...this.#live.values()]) {
      if (
        runtimeKey(binding.row) === key &&
        (this.#live.get(bindingKey(binding.row)) === binding || binding.expiresAt > this.#now())
      )
        candidates.set(JSON.stringify(binding.endpoint), binding);
    }
    if (!this.#observationHistoryExhausted && !this.#ambiguous.has(key) && candidates.size === 1)
      return structuredClone(candidates.values().next().value!.endpoint);
    return {
      kind: "unresolved-pane",
      environmentId: this.#environmentId,
      serverScope: structuredClone(this.#serverScope),
      observationRef: randomUUID(),
    };
  }

  /** Grant must come directly from the current credential authority, never caller JSON. */
  captureSourceBinding(
    grant: PaneSourceBinding,
  ): { endpoint: ResolvedEndpoint; bindingId: string } | null {
    this.#assertOpen();
    const candidates = [...this.#live.values()].filter(
      (binding) =>
        binding.row.sessionName === grant.session &&
        binding.row.runtimePaneId === grant.runtimePaneId &&
        binding.row.semanticPaneId === grant.semanticPaneId,
    );
    return candidates.length === 1
      ? { endpoint: structuredClone(candidates[0]!.endpoint), bindingId: grant.bindingId }
      : null;
  }

  isCurrent(endpoint: ResolvedEndpoint): boolean {
    if (this.#disposed) return false;
    return [...this.#live.values()].some(
      (binding) => JSON.stringify(binding.endpoint) === JSON.stringify(endpoint),
    );
  }

  dispose(): void {
    this.#disposed = true;
    this.#live.clear();
    this.#history.clear();
    this.#seen.clear();
    this.#ambiguous.clear();
  }
}
