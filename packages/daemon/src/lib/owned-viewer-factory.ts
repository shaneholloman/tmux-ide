import type { TmuxServerScope } from "@tmux-ide/contracts";
import { OwnedViewerAdapter } from "../terminal/mirror/owned-viewer-adapter.ts";
import type { OwnerInteractionObservation } from "./owner-interaction-observation.ts";
import type { InteractionObservationStatusStore } from "./interaction-observation-status.ts";

/** Pin each adapter to exactly one owner object and generation; never borrow reader identity. */
export function createOwnedViewerAdapterFactory(options: {
  environmentId: string;
  serverScope: TmuxServerScope;
  observation: OwnerInteractionObservation;
  status: InteractionObservationStatusStore;
}): () => OwnedViewerAdapter {
  const owner = options.observation;
  return () =>
    new OwnedViewerAdapter({
      environmentId: options.environmentId,
      serverScope: options.serverScope,
      capability: () =>
        owner.ownedOperationTransport &&
        owner.ownedOperationEpochGuard &&
        owner.ownedOperationPaneGuard &&
        owner.nativeServerEpoch
          ? {
              serverEpoch: owner.nativeServerEpoch,
              atomicPaneSnapshot: owner.atomicPaneSnapshot,
              atomicPaneSnapshotDual: owner.atomicPaneSnapshotDual,
            }
          : null,
      subscribeReady: (listener) => options.status.subscribe(listener),
      register: (identity) => owner.registerOwnedConnection(identity, "viewer"),
      admit: (request) => owner.admitOwnedOperation(request),
      acknowledge: (permit, connection, ack) =>
        owner.acknowledgeOwnedOperation(permit, connection, ack),
      cancelUndispatched: (permit) => owner.cancelUndispatchedOwnedOperation(permit),
      close: (connection) => owner.closeOwnedConnection(connection),
      uncertain: () => owner.noteOwnedOperationUncertainty(),
    });
}
