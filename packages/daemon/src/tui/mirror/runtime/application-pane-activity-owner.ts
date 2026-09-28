import type {
  InteractionReceipt,
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
  initialInteractionFeedState,
  interactionPresenceIsFresh,
  reduceInteractionReceipt,
  type PaneInteractionProjection,
} from "@tmux-ide/core";
export interface ApplicationInteractionSource {
  readonly environmentId: string;
  readonly server: TmuxServerScope;
  readonly baseUrl: string;
  readonly ownerToken: string;
}
export type ApplicationPaneActivity = Accessor<ReadonlyMap<string, PaneInteractionProjection>> & {
  readonly activity: Accessor<readonly InteractionReceipt[]>;
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
  const [activity, setActivity] = createSignal<readonly InteractionReceipt[]>([]);
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
    setPanes(new Map(current));
    setActivity(
      feed.activity.filter(
        (receipt) =>
          receipt.operationKind === "workspace.pane.read" ||
          receipt.operationKind === "workspace.pane.send",
      ),
    );
    if (current.length)
      timer = setTimeout(
        publish,
        Math.max(
          1,
          Math.min(...current.map(([, value]) => Date.parse(value.at) + INTERACTION_PRESENCE_MS)) -
            now +
            1,
        ),
      );
  };
  const forget = (key: string) => {
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
    if (disposed || entries.get(key) !== entry) return;
    const subscription = subscribe({
      ...entry.source,
      resume: entry.cursor,
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
        if (batch.gap) forget(key);
        for (const receipt of batch.receipts) {
          if (
            receipt.operationKind === "workspace.pane.read" ||
            receipt.operationKind === "workspace.pane.send"
          )
            feed = reduceInteractionReceipt(feed, receipt);
        }
        entry.attempts = 0;
        publish();
      },
    });
    entry.subscription = subscription;
    void subscription.done.catch((error: unknown) => {
      if (disposed || entries.get(key) !== entry) return;
      entry.cursor = subscription.getCursor();
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
        next.ownerToken === entry.source.ownerToken
      )
        continue;
      entries.delete(key);
      stop(entry);
      forget(key);
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
  return Object.assign(panes, { activity });
}
