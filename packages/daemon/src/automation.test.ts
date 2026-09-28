import { describe, expect, it, vi } from "vitest";
import type { AutomationClient } from "@tmux-ide/daemon-client/automation-client";
import { AutomationInvocationError } from "@tmux-ide/daemon-client/automation-client";
import { DAEMON_WIRE_PROTOCOL_VERSION } from "@tmux-ide/contracts";
import { localAutomationClient, readAutomationRequest, runAutomationCli } from "./automation.ts";

const id = "00000000-0000-4000-8000-000000000001";
const handle = { generation: id, operationId: id };
const target = {
  kind: "pane",
  environmentId: id,
  paneLifetimeId: id,
  serverScope: { serverId: `tmux-server.${"a".repeat(32)}`, generation: id },
  workspaceName: "workspace.project",
  semanticPaneId: "pane.editor",
};
const intent = { kind: "send", source: null, target, text: "private", enter: true };
async function* input(value: unknown) {
  yield Buffer.from(JSON.stringify(value));
}
function fakeClient() {
  return {
    discover: vi.fn(async () => ({ version: 1 as const, panes: [] })),
    reserve: vi.fn(async () => ({ version: 1 as const, handle })),
    execute: vi.fn(async () => ({
      version: 1 as const,
      handle,
      result: { kind: "send" as const, submitted: true },
    })),
    status: vi.fn(async () => ({
      version: 1 as const,
      handle,
      status: "outcome-unknown" as const,
    })),
    subscribe: vi.fn(),
  } satisfies AutomationClient;
}

describe("automation CLI adapter", () => {
  it.each(["identity", "protocol", "record", "health", "valid"])(
    "checks canonical %s before reading a source credential",
    async (scenario) => {
      const record = {
        pid: 1234,
        port: 4567,
        bindHostname: "127.0.0.1",
        protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
        productVersion: "test",
        instanceId: id,
        startedAt: "2026-09-28T00:00:00Z",
        authToken: "private-owner-token",
      };
      const read = vi
        .fn()
        .mockReturnValueOnce(record)
        .mockReturnValue({
          ...record,
          ...(scenario === "record" ? { port: 9999 } : {}),
        });
      const credential = vi.fn(() => "private-source-token");
      const work = localAutomationClient({
        read,
        alive: async () => true,
        identity: async () => ({
          ...record,
          ok: true,
          ...(scenario === "identity" ? { pid: 9999 } : {}),
          ...(scenario === "protocol" ? { protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION - 1 } : {}),
        }),
        health: async () => (scenario === "health" ? null : { ...record, ok: true, uptime: 1 }),
        credential,
      });
      if (scenario === "valid") {
        await expect(work).resolves.toHaveProperty("execute");
        expect(credential).toHaveBeenCalledOnce();
      } else {
        await expect(work).rejects.toThrow("compatible");
        expect(credential).not.toHaveBeenCalled();
      }
    },
  );

  it("sends once through reservation and shared execution without a raw fallback", async () => {
    const client = fakeClient();
    const output = vi.fn();
    await runAutomationCli(["send", "--json"], { client, input: input(intent), output });
    expect(client.reserve).toHaveBeenCalledExactlyOnceWith(intent);
    expect(client.execute).toHaveBeenCalledExactlyOnceWith(handle, intent);
    expect(output).toHaveBeenCalledWith({
      version: 1,
      handle,
      result: { kind: "send", submitted: true },
    });
  });

  it("retains the uncertain handle for JSON error recovery without repeating input", async () => {
    const client = fakeClient();
    client.execute.mockRejectedValue(new AutomationInvocationError("response-unconfirmed", handle));
    const error = await runAutomationCli(["send"], {
      client,
      input: input(intent),
      output: () => {},
    }).catch((reason) => reason);
    expect(error.toJSON()).toMatchObject({ handle, code: "response-unconfirmed" });
    expect(JSON.stringify(error.toJSON())).not.toContain("private");
    expect(client.reserve).toHaveBeenCalledTimes(1);
    expect(client.execute).toHaveBeenCalledTimes(1);
  });

  it("executes an explicitly supplied handle without reserving", async () => {
    const client = fakeClient();
    await runAutomationCli(["execute"], {
      client,
      input: input({ version: 1, handle, intent }),
      output: () => {},
    });
    expect(client.reserve).not.toHaveBeenCalled();
    expect(client.execute).toHaveBeenCalledExactlyOnceWith(handle, intent);
  });

  it("queries status without reading stdin or executing anything", async () => {
    const client = fakeClient();
    async function* forbidden() {
      yield await Promise.reject<string>(Error("stdin read"));
    }
    await runAutomationCli(["status", id, id], { client, input: forbidden(), output: () => {} });
    expect(client.status).toHaveBeenCalledExactlyOnceWith(handle);
    expect(client.execute).not.toHaveBeenCalled();
  });

  it("rejects kind mismatches before reserving", async () => {
    const client = fakeClient();
    await expect(runAutomationCli(["read"], { client, input: input(intent) })).rejects.toThrow(
      "does not match",
    );
    expect(client.reserve).not.toHaveBeenCalled();
  });

  it("bounds and strictly decodes stdin", async () => {
    async function* oversized() {
      yield Buffer.alloc(65537, 32);
    }
    async function* malformed() {
      yield Buffer.from([0xff]);
    }
    await expect(readAutomationRequest(oversized())).rejects.toThrow("64 KiB");
    await expect(readAutomationRequest(malformed())).rejects.toThrow("Expected a JSON");
  });
});
