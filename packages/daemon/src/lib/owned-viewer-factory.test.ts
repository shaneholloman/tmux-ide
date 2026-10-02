import { expect, it, vi } from "vitest";
import { createOwnedViewerAdapterFactory } from "./owned-viewer-factory.ts";
import { InteractionObservationStatusStore } from "./interaction-observation-status.ts";
import type { OwnerInteractionObservation } from "./owner-interaction-observation.ts";
import type { MirrorChannelIo } from "../terminal/mirror/control-channel.ts";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
it.each(["default", "nondefault"])("pins %s adapters to its scope and attached issuer", (kind) => {
  const serverScope = {
    serverId: `tmux-server.${(kind === "default" ? "a" : "b").repeat(32)}`,
    generation: id(2),
  };
  const status = new InteractionObservationStatusStore(id(1), serverScope);
  const owner = {
    ownedOperationTransport: true,
    ownedOperationEpochGuard: true,
    ownedOperationPaneGuard: true,
    nativeServerEpoch: id(3),
    registerOwnedConnection: vi.fn(() => ({ bindingId: id(4) })),
    admitOwnedOperation: vi.fn(() => null),
    closeOwnedConnection: vi.fn(),
    noteOwnedOperationUncertainty: vi.fn(),
  };
  const factory = createOwnedViewerAdapterFactory({
    environmentId: id(1),
    serverScope,
    status,
    observation: owner as unknown as OwnerInteractionObservation,
  });
  const adapter = factory();
  const identity = {
    schemaVersion: 2 as const,
    type: "identity" as const,
    serverEpoch: id(3),
    connectionId: "77",
  };
  const io = {
    nativeViewerIdentity: identity,
    commandNativeViewerInline: vi.fn(),
  } as unknown as MirrorChannelIo;
  adapter.bindIo(io);
  expect(adapter.controlOptions()!.onIdentity(identity)).toBe(true);
  adapter.tryDispatch(
    io,
    {
      paneId: "%0",
      paneBirthId: "8",
      commands: [["send-keys", "-t", "%0", "Enter"]],
      resultIndex: 0,
      limits: { maxBytes: 100, maxLines: 1 },
    },
    vi.fn(),
  );
  expect(owner.registerOwnedConnection).toHaveBeenCalledWith(identity, "viewer");
  expect(owner.admitOwnedOperation).toHaveBeenCalledWith(
    expect.objectContaining({
      target: expect.objectContaining({ serverScope, environmentId: id(1) }),
    }),
  );
  owner.ownedOperationPaneGuard = false;
  expect(adapter.controlOptions()).toBeUndefined();
  adapter.dispose();
  expect(owner.closeOwnedConnection).toHaveBeenCalledOnce();
  status.dispose();
});
