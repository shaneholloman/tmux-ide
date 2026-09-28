import { expect, it, vi } from "vitest";
import type { OwnerInteractionObservation } from "./owner-interaction-observation.ts";
import { createBackgroundNativeCapture } from "./background-native-capture.ts";
const epoch = "11111111-1111-4111-8111-111111111111";
const request = {
  paneId: "%1",
  nativeIdentity: { serverEpoch: epoch, paneBirthId: "2" },
  mode: "fleet-preview" as const,
};
function rig(output = "", failure?: "prefix" | "error") {
  const observer = {
    ownedOperationTransport: true,
    ownedOperationPaneGuard: true,
    ownedOperationSessionGuard: true,
    nativeServerEpoch: epoch,
    admitOneShotViewerCapture: vi.fn((r: { operationId: string }) => ({
      operationId: r.operationId,
    })),
    acknowledgeOneShotViewerCapture: vi.fn(() => true),
    cancelUndispatchedOwnedOperation: vi.fn(),
    abandonUnacknowledgedOwnedOperation: vi.fn(),
    noteOwnedOperationUncertainty: vi.fn(),
  };
  const run = vi.fn(async (args: readonly string[]) => {
    const operationId = args[args.indexOf("-O") + 1];
    const metadata =
      JSON.stringify({
        schemaVersion: 2,
        type: "identity",
        serverEpoch: epoch,
        connectionId: "7",
      }) +
      "\n" +
      JSON.stringify({
        schemaVersion: 2,
        type: "operation-identity",
        serverEpoch: epoch,
        connectionId: "7",
        wrapperCommandId: "8",
        operationId,
      }) +
      "\n";
    if (failure === "error")
      throw Object.assign(new Error("private content"), { stdout: metadata + output });
    return failure === "prefix" ? "bad metadata\n" + output : metadata + output;
  });
  const capture = createBackgroundNativeCapture({
    environmentId: epoch,
    serverScope: { serverId: `tmux-server.${"a".repeat(32)}`, generation: epoch },
    observation: () => observer as unknown as OwnerInteractionObservation,
    runPinnedTmux: run,
  });
  return { observer, run, capture };
}
it.each(["", "row\n\n", '{"type":"identity"}\n'])(
  "captures exact bytes once without exposing private prefix: %j",
  async (output) => {
    const r = rig(output);
    expect(await r.capture(request)).toEqual({ output });
    expect(r.run).toHaveBeenCalledTimes(1);
    expect(r.observer.admitOneShotViewerCapture).toHaveBeenCalledTimes(1);
    expect(r.observer.acknowledgeOneShotViewerCapture).toHaveBeenCalledTimes(1);
    expect(r.run.mock.calls[0]![0]).toContain("-B");
    expect(r.run.mock.calls[0]![0]).not.toContain("attach-session");
  },
);
it("falls back only before dispatch and never captures when already aborted", async () => {
  const r = rig();
  r.observer.ownedOperationTransport = false;
  expect(await r.capture(request)).toBeNull();
  expect(r.run).not.toHaveBeenCalled();
  r.observer.ownedOperationTransport = true;
  const signal = AbortSignal.abort();
  await expect(r.capture(request, signal)).rejects.toBeDefined();
  expect(r.observer.admitOneShotViewerCapture).not.toHaveBeenCalled();
});
it("metadata consumer exceptions preserve decoded capture and never recapture", async () => {
  const r = rig("snapshot\n");
  r.observer.acknowledgeOneShotViewerCapture.mockImplementation(() => {
    throw Error("consumer");
  });
  expect(await r.capture(request)).toEqual({ output: "snapshot\n" });
  expect(r.run).toHaveBeenCalledTimes(1);
});
it.each(["prefix", "error"] as const)(
  "failed %s exposes no captured content and never retries",
  async (failure) => {
    const r = rig("SECRET_CAPTURE", failure);
    await expect(r.capture(request)).rejects.toThrow(/Background pane capture/);
    try {
      await r.capture(request);
    } catch (e) {
      expect(String(e)).not.toContain("SECRET_CAPTURE");
      expect(String(e)).not.toContain("private content");
    }
    expect(r.run).toHaveBeenCalledTimes(2);
    expect(r.observer.abandonUnacknowledgedOwnedOperation).toHaveBeenCalledTimes(2);
    expect(r.observer.cancelUndispatchedOwnedOperation).not.toHaveBeenCalled();
  },
);
it("keeps caller cancellation and output bounds on the one dispatched runner", async () => {
  const r = rig();
  const controller = new AbortController();
  r.run.mockImplementation(async () => {
    controller.abort();
    throw Error("aborted");
  });
  await expect(r.capture(request, controller.signal)).rejects.toThrow("aborted");
  expect(r.run).toHaveBeenCalledTimes(1);
  expect(r.run).toHaveBeenCalledWith(expect.any(Array), controller.signal, {
    preserveTrailingNewlines: true,
    maxOutputBytes: 67586,
  });
});
it("refuses capture payload beyond its budget without leaking or recapturing", async () => {
  const r = rig("x".repeat(65537));
  await expect(r.capture(request)).rejects.toThrow("acknowledgement unavailable");
  expect(r.run).toHaveBeenCalledTimes(1);
});
it("snapshots native identity before an asynchronous caller can mutate it", async () => {
  const r = rig("snapshot"),
    copied = { ...request, nativeIdentity: { ...request.nativeIdentity } };
  const result = r.capture(copied);
  copied.nativeIdentity.serverEpoch = "22222222-2222-4222-8222-222222222222";
  await expect(result).resolves.toEqual({ output: "snapshot" });
});
