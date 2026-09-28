import { expect, it, vi } from "vitest";
import { OwnedNativeInteractionBindings } from "../../lib/owned-native-interaction-bindings.ts";
import { OwnedViewerAdapter } from "./owned-viewer-adapter.ts";
import type { MirrorChannelIo, NativeViewerControlRequest } from "./control-channel.ts";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const environmentId = id(1),
  serverEpoch = id(2);
const serverScope = { serverId: `tmux-server.${"a".repeat(32)}`, generation: id(3) };
const identity = {
  schemaVersion: 2 as const,
  type: "identity" as const,
  serverEpoch,
  connectionId: "7",
};
const request = {
  paneId: "%0",
  paneBirthId: "1",
  commands: [["send-keys", "-t", "%0", "Enter"]],
  resultIndex: 0,
  limits: { maxBytes: 1024, maxLines: 2 },
};
function setup() {
  const bindings = new OwnedNativeInteractionBindings({ environmentId, serverScope, serverEpoch });
  const uncertain = vi.fn();
  let ready = true;
  let capabilityFailure = false;
  const adapter = new OwnedViewerAdapter({
    environmentId,
    serverScope,
    capability: () => {
      if (capabilityFailure) throw new Error("retired owner");
      return ready ? { serverEpoch } : null;
    },
    register: (value) => bindings.registerConnection(value, "viewer"),
    admit: (value) => bindings.admit(value),
    acknowledge: (permit, connection, ack) => {
      bindings.acknowledge(permit, connection, ack);
    },
    cancelUndispatched: (permit) => {
      bindings.cancelUndispatchedOperation(permit);
    },
    close: (connection) => {
      bindings.closeConnection(connection);
    },
    uncertain,
  });
  const send = vi.fn((_request: NativeViewerControlRequest, _reply: unknown) => false);
  const io = {
    nativeViewerIdentity: identity,
    commandNativeViewerInline: send,
  } as unknown as MirrorChannelIo;
  adapter.bindIo(io);
  return {
    adapter,
    bindings,
    io,
    send,
    uncertain,
    failCapability: () => {
      capabilityFailure = true;
    },
    disable: () => {
      ready = false;
    },
    options: adapter.controlOptions()!,
  };
}
it("requires real handshake, exact IO and live capability", () => {
  const s = setup();
  expect(s.adapter.tryDispatch(s.io, request, vi.fn())).toBe(false);
  expect(s.options.onIdentity(identity)).toBe(true);
  expect(s.adapter.tryDispatch({ ...s.io }, request, vi.fn())).toBe(false);
  expect(() => s.adapter.bindIo({ ...s.io })).toThrow();
  s.disable();
  expect(s.adapter.tryDispatch(s.io, request, vi.fn())).toBe(false);
  expect(s.send).not.toHaveBeenCalled();
});
it("cancels 600 no-write refusals without consuming capacity", () => {
  const s = setup();
  s.options.onIdentity(identity);
  for (let i = 0; i < 600; i++) expect(s.adapter.tryDispatch(s.io, request, vi.fn())).toBe(false);
  expect(s.bindings.size.permits).toBe(0);
  expect(s.send).toHaveBeenCalledTimes(600);
  s.adapter.dispose();
  s.options.onRetired();
  expect(s.bindings.size.connections).toBe(0);
});
it("never falls back after ambiguous transport throw", () => {
  const s = setup();
  s.options.onIdentity(identity);
  s.send.mockImplementation(() => {
    throw new Error("after write");
  });
  const reply = vi.fn();
  expect(s.adapter.tryDispatch(s.io, request, reply)).toBe(true);
  expect(reply).toHaveBeenCalledExactlyOnceWith({ ok: false, lines: [] });
  expect(s.uncertain).toHaveBeenCalledOnce();
  expect(s.bindings.size.permits).toBe(1);
  s.adapter.dispose();
  expect(s.bindings.size.permits).toBe(0);
});
it("rejects wrong epoch and absent capability", () => {
  const s = setup();
  expect(s.options.onIdentity({ ...identity, serverEpoch: id(9) })).toBe(false);
  s.disable();
  expect(s.adapter.controlOptions()).toBeUndefined();
});
it("cancellation checks exact token and refuses acknowledged permits", () => {
  const s = setup();
  const connection = s.bindings.registerConnection(identity, "viewer")!;
  const admit = () =>
    s.bindings.admit({
      operationId: id(5),
      role: "viewer",
      source: null,
      connection,
      target: { kind: "native-pane", environmentId, serverScope, serverEpoch, paneBirthId: "1" },
      commands: ["send-keys"],
    })!;
  const first = admit();
  s.bindings.cancelUndispatchedOperation({ ...first });
  expect(s.bindings.size.permits).toBe(1);
  s.bindings.cancelUndispatchedOperation(first);
  expect(s.bindings.size.permits).toBe(0);
  const second = admit();
  s.bindings.cancelUndispatchedOperation(first);
  expect(s.bindings.size.permits).toBe(1);
  s.bindings.acknowledge(second, connection, {
    schemaVersion: 2,
    type: "operation-identity",
    serverEpoch,
    connectionId: "7",
    wrapperCommandId: "8",
    operationId: id(5),
  });
  s.bindings.cancelUndispatchedOperation(second);
  expect(s.bindings.size.permits).toBe(1);
});

it("keeps terminal success and suppresses duplicate replies when metadata fails", () => {
  const s = setup();
  s.options.onIdentity(identity);
  const reply = vi.fn(() => {
    throw new Error("caller");
  });
  s.send.mockImplementation((_request, callback) => {
    const deliver = callback as (value: unknown) => void;
    deliver({ ok: true, lines: ["snapshot"], metadataStatus: "invalid", acknowledgement: null });
    deliver({ ok: false, lines: [], metadataStatus: "invalid", acknowledgement: null });
    return true;
  });
  expect(
    s.adapter.tryDispatch(
      s.io,
      { ...request, commands: [["capture-pane", "-p", "-t", "%0"]] },
      reply,
    ),
  ).toBe(true);
  expect(reply).toHaveBeenCalledOnce();
  expect(reply.mock.calls[0]?.[0]).toMatchObject({ ok: true, lines: ["snapshot"] });
});

it("acknowledges only this handshake grant and retires it on control exit", () => {
  const s = setup();
  s.options.onIdentity(identity);
  s.send.mockImplementation((request) => {
    request.onAcknowledgement?.({
      schemaVersion: 2,
      type: "operation-identity",
      serverEpoch,
      connectionId: "7",
      wrapperCommandId: "8",
      operationId: request.operationId,
    });
    return true;
  });
  expect(s.adapter.tryDispatch(s.io, request, vi.fn())).toBe(true);
  expect(s.bindings.size.permits).toBe(1);
  s.options.onRetired();
  expect(s.bindings.size).toMatchObject({ permits: 0, connections: 0 });
  expect(s.adapter.tryDispatch(s.io, request, vi.fn())).toBe(false);
});

it("treats a throwing owner capability as optional metadata failure", () => {
  const s = setup();
  s.options.onIdentity(identity);
  s.failCapability();
  expect(s.adapter.controlOptions()).toBeUndefined();
  expect(s.adapter.tryDispatch(s.io, request, vi.fn())).toBe(false);
  expect(s.send).not.toHaveBeenCalled();
  s.adapter.dispose();
  s.adapter.dispose();
  expect(s.bindings.size.connections).toBe(0);
});
