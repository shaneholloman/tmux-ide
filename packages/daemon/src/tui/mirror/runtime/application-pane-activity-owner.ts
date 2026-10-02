import { receiptIsHeaderWorthy } from "../ui/pane-interaction-presentation.ts";
import { applicationMachineAuthorityManager } from "./application-machine-authority.ts";
import { canonicalDaemonUrl } from "../../../lib/canonical-daemon.ts";
import type {
  InteractionJournalEntry,
  NativePaneIdentity,
  InteractionPaneEndpoint,
  InteractionObservationStatus,
  TmuxServerScope,
  TmuxInteractionCursor,
} from "@tmux-ide/contracts";
import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";
import {
  subscribeTmuxServerInteractions,
  type TmuxInteractionSubscription,
} from "@tmux-ide/daemon-client/tmux-server-interaction-events";
import {
  INTERACTION_PRESENCE_MS,
  interactionForPane,
  interactionActivityAt,
  interactionIsViewerActivity,
  initialInteractionFeedState,
  interactionPresenceIsFresh,
  reduceInteractionReceipt,
  type PaneInteractionProjection,
} from "@tmux-ide/core";
export interface ApplicationInteractionSource {
  /** Retained scope while its machine reconnects; carries no usable credentials. */
  readonly available?: boolean;
  readonly environmentId: string;
  readonly server: TmuxServerScope;
  readonly baseUrl: string;
  readonly ownerToken: string;
}
type EndpointCarrier = {
  readonly interactionEndpoint: Extract<InteractionPaneEndpoint, { kind: "pane" }> | null;
};
interface ActivityMachineGroup {
  readonly id: string;
  readonly state: string;
  readonly environmentId?: string | null;
  readonly agents?: readonly EndpointCarrier[];
}
type ActivityDaemonAuthority = {
  readonly bindHostname: string;
  readonly port: number;
  readonly authToken?: string | null;
};

/** Select authenticated routes and retain credential-free suspended scopes from matching inventory. */
export function applicationPaneActivitySources(
  groups: readonly ActivityMachineGroup[],
  selectedMachineId: string | null,
  resources: readonly EndpointCarrier[],
  readAuthority: (machineId: string) => ActivityDaemonAuthority | null | undefined,
): readonly ApplicationInteractionSource[] {
  const sources = new Map<string, ApplicationInteractionSource>();
  for (const group of groups) {
    const suspended = group.state === "connecting" || group.state === "disconnected";
    if ((!suspended && group.state !== "ready") || !group.environmentId) continue;
    const daemon = suspended ? null : readAuthority(group.id);
    if (!suspended && !daemon?.authToken) continue;
    const endpoints = (group.agents ?? []).flatMap((agent) =>
      agent.interactionEndpoint ? [agent.interactionEndpoint] : [],
    );
    if (group.id === selectedMachineId)
      endpoints.push(
        ...resources.flatMap((resource) =>
          resource.interactionEndpoint ? [resource.interactionEndpoint] : [],
        ),
      );
    for (const endpoint of endpoints) {
      if (endpoint.environmentId !== group.environmentId) continue;
      const key = JSON.stringify([
        endpoint.environmentId,
        endpoint.serverScope.serverId,
        endpoint.serverScope.generation,
      ]);
      // A disconnected alias must not hide an authenticated route to this scope.
      if (suspended && sources.has(key)) continue;
      sources.set(key, {
        environmentId: endpoint.environmentId,
        server: endpoint.serverScope,
        ...(suspended
          ? { available: false, baseUrl: "", ownerToken: "" }
          : {
              baseUrl: canonicalDaemonUrl("http", daemon!.bindHostname, daemon!.port),
              ownerToken: daemon!.authToken!,
            }),
      });
    }
  }
  return [...sources.values()];
}

/** Root composition facade; source selection and owner authentication belong together. */
export function createMachinePaneActivity(
  machines: { readonly sidebar: { readonly groups: Accessor<readonly ActivityMachineGroup[]> } },
  selectedMachineId: Accessor<string | null>,
  shell: Accessor<{
    readonly semantic?: {
      readonly terminalInventory?: { readonly resources: readonly EndpointCarrier[] };
    } | null;
  }>,
): ApplicationPaneActivity {
  return createApplicationPaneActivityOwner(() =>
    applicationPaneActivitySources(
      machines.sidebar.groups(),
      selectedMachineId(),
      shell().semantic?.terminalInventory?.resources ?? [],
      (machineId) => applicationMachineAuthorityManager.getMachine(machineId)?.read(),
    ),
  );
}

export type ApplicationPaneActivity = Accessor<ReadonlyMap<string, PaneInteractionProjection>> & {
  readonly activity: Accessor<readonly InteractionJournalEntry[]>;
  readonly observationStatus: (
    endpoint: InteractionPaneEndpoint,
  ) => InteractionObservationStatus | null;
};
const ownerKey = (source: Pick<ApplicationInteractionSource, "environmentId" | "server">) =>
  JSON.stringify([source.environmentId, source.server.serverId, source.server.generation]);
const endpointOwnerKey = (endpoint: { environmentId: string; serverScope: TmuxServerScope }) =>
  ownerKey({ environmentId: endpoint.environmentId, server: endpoint.serverScope });
/** One receipt clock per owner, consumed in complete batches; never legacy lastObservedReceipt. */
export function createApplicationPaneActivityOwner(
  sources: Accessor<readonly ApplicationInteractionSource[]>,
  subscribe = subscribeTmuxServerInteractions,
): ApplicationPaneActivity {
  const [panes, setPanes] = createSignal<ReadonlyMap<string, PaneInteractionProjection>>(new Map());
  const [activity, setActivity] = createSignal<readonly InteractionJournalEntry[]>([]);
  const [statuses, setStatuses] = createSignal<ReadonlyMap<string, InteractionObservationStatus>>(
    new Map(),
  );
  const forgetStatus = (key: string) =>
    setStatuses((previous) => {
      const next = new Map(previous);
      next.delete(key);
      return next;
    });
  let feed = initialInteractionFeedState();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  type Entry = {
    source: ApplicationInteractionSource;
    subscription: TmuxInteractionSubscription | null;
    retry: ReturnType<typeof setTimeout> | null;
    cursor?: TmuxInteractionCursor;
    attempts: number;
  };
  const entries = new Map<string, Entry>();
  const publish = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    const now = Date.now();
    const current = Object.entries(feed.panes)
      .filter(([, value]) => interactionPresenceIsFresh(value, now))
      .slice(-128);
    feed = { ...feed, panes: Object.fromEntries(current) };
    const snapshot = feed;
    setPanes(
      Object.assign(new Map(current), {
        forPane: (
          endpoint: Extract<InteractionPaneEndpoint, { kind: "pane" }>,
          nativeIdentity?: NativePaneIdentity | null,
        ) => {
          const value = interactionForPane(
            snapshot,
            endpoint,
            nativeIdentity,
            receiptIsHeaderWorthy,
          );
          return value && interactionPresenceIsFresh(value, Date.now()) ? value : undefined;
        },
      }),
    );
    setActivity(
      feed.activity.filter(
        (receipt) =>
          !interactionIsViewerActivity(receipt) &&
          (receipt.type === "interaction.evidence" ||
            receipt.operationKind === "workspace.pane.read" ||
            receipt.operationKind === "workspace.pane.send"),
      ),
    );
    const deadlines = [
      ...current.map(([, value]) => Date.parse(value.at) + INTERACTION_PRESENCE_MS),
      ...feed.activity
        .filter((entry) => entry.type === "interaction.evidence" && receiptIsHeaderWorthy(entry))
        .map((entry) => Date.parse(interactionActivityAt(entry)) + INTERACTION_PRESENCE_MS),
    ].filter((deadline) => deadline >= now && deadline <= now + INTERACTION_PRESENCE_MS);
    if (deadlines.length)
      timer = setTimeout(publish, Math.max(1, Math.min(...deadlines) - now + 1));
  };
  const forget = (key: string, retire = true) => {
    if (retire) forgetStatus(key);
    feed = {
      ...feed,
      cursors: Object.fromEntries(Object.entries(feed.cursors).filter(([scope]) => scope !== key)),
      activity: feed.activity.filter(
        (receipt) =>
          !receipt.evidence || endpointOwnerKey(receipt.evidence.endpoints.destination) !== key,
      ),
      panes: Object.fromEntries(
        Object.entries(feed.panes).filter(
          ([, projection]) =>
            endpointOwnerKey(projection.destinationEndpoint) !== key &&
            endpointOwnerKey(projection.endpoint) !== key,
        ),
      ),
    };
  };
  const stop = (entry: Entry) => {
    entry.subscription?.close();
    if (entry.retry !== null) clearTimeout(entry.retry);
    entry.retry = null;
  };
  const connect = (key: string, entry: Entry) => {
    if (disposed || entries.get(key) !== entry || entry.source.available === false) return;
    const subscription = subscribe({
      ...entry.source,
      resume: entry.cursor,
      onStatus(status) {
        if (disposed || entries.get(key) !== entry) return;
        if (endpointOwnerKey(status) !== key) throw new Error("Foreign observation status");
        setStatuses((previous) => new Map(previous).set(key, status));
      },
      onBatch(batch, signal) {
        if (signal.aborted || disposed || entries.get(key) !== entry) return;
        // Scope is validated by transport; environment belongs to this authenticated daemon route.
        if (
          batch.receipts.some(
            (receipt) =>
              receipt.evidence && endpointOwnerKey(receipt.evidence.endpoints.destination) !== key,
          )
        )
          throw new Error("Foreign receipt environment");
        if (batch.gap) forget(key, false);
        for (const receipt of batch.receipts) {
          if (
            receipt.type === "interaction.evidence" ||
            receipt.operationKind === "workspace.pane.read" ||
            receipt.operationKind === "workspace.pane.send"
          )
            feed = reduceInteractionReceipt(feed, receipt, receiptIsHeaderWorthy);
        }
        entry.attempts = 0;
        publish();
      },
    });
    entry.subscription = subscription;
    void subscription.done.catch((error: unknown) => {
      if (disposed || entries.get(key) !== entry) return;
      entry.cursor = subscription.getCursor();
      forgetStatus(key);
      if (error instanceof Error && error.message === "Receipt owner retired") {
        forget(key);
        publish();
        return;
      }
      entry.retry = setTimeout(
        () => {
          entry.retry = null;
          connect(key, entry);
        },
        Math.min(5000, 250 * 2 ** Math.min(entry.attempts++, 5)),
      );
    });
  };
  createEffect(() => {
    // Admission bound applies to active transports, not an ever-growing history of scopes.
    const wanted = new Map(
      sources()
        .slice(0, 64)
        .map((source) => [ownerKey(source), source]),
    );
    for (const [key, entry] of entries) {
      const next = wanted.get(key);
      if (
        next &&
        next.baseUrl === entry.source.baseUrl &&
        next.ownerToken === entry.source.ownerToken &&
        next.available === entry.source.available
      )
        continue;
      entries.delete(key);
      const cursor = entry.subscription?.getCursor() ?? entry.cursor;
      stop(entry);
      if (!next) {
        forget(key);
        continue;
      }
      // Transport URLs and tokens are not journal identity. Preserve only this
      // exact environment/server/generation, with a fresh entry fencing late callbacks.
      forgetStatus(key);
      const replacement: Entry = {
        source: next,
        subscription: null,
        retry: null,
        cursor,
        attempts: 0,
      };
      entries.set(key, replacement);
      connect(key, replacement);
    }
    for (const [key, source] of wanted)
      if (!entries.has(key)) {
        const entry: Entry = { source, subscription: null, retry: null, attempts: 0 };
        entries.set(key, entry);
        connect(key, entry);
      }
    publish();
  });
  onCleanup(() => {
    disposed = true;
    for (const entry of entries.values()) stop(entry);
    entries.clear();
    if (timer !== null) clearTimeout(timer);
  });
  return Object.assign(panes, {
    activity,
    observationStatus: (endpoint: InteractionPaneEndpoint) =>
      statuses().get(endpointOwnerKey(endpoint)) ?? null,
  });
}
