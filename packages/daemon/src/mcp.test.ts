import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import {
  AutomationInvocationError,
  type AutomationClient,
} from "@tmux-ide/daemon-client/automation-client";
import { createTmuxIdeMcpServer } from "./mcp.ts";

const id = "00000000-0000-4000-8000-000000000001";
const handle = { generation: id, operationId: id };
const intent = {
  kind: "send",
  source: null,
  text: "private",
  enter: true,
  target: {
    kind: "pane",
    environmentId: id,
    paneLifetimeId: id,
    serverScope: { serverId: `tmux-server.${"a".repeat(32)}`, generation: id },
    workspaceName: "workspace.project",
    semanticPaneId: "pane.editor",
  },
};
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
async function connect(client: AutomationClient) {
  const input = new PassThrough();
  const output = new PassThrough();
  const pending = new Map<number, (value: Record<string, unknown>) => void>();
  let buffer = "";
  let sequence = 0;
  output.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const value = JSON.parse(buffer.slice(0, end)) as Record<string, unknown>;
      buffer = buffer.slice(end + 1);
      if (typeof value.id === "number") {
        pending.get(value.id)?.(value);
        pending.delete(value.id);
      }
    }
  });
  const server = serveStdio(() => createTmuxIdeMcpServer(client), {
    transport: new StdioServerTransport(input, output, { maxBufferSize: 128 * 1024 }),
  });
  const rpc = (method: string, params: unknown) => {
    const id = ++sequence;
    const result = new Promise<Record<string, unknown>>((resolve) => pending.set(id, resolve));
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return result;
  };
  await rpc("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return {
    rpc,
    close: async () => {
      await server.close();
      input.destroy();
      output.destroy();
    },
  };
}

describe("MCP stdio adapter", () => {
  it("negotiates the real protocol and exposes only the reviewed tool set", async () => {
    const wire = await connect(fakeClient());
    try {
      const response = await wire.rpc("tools/list", {});
      const result = response.result as { tools: { name: string }[] };
      expect(result.tools.map((tool) => tool.name).sort()).toEqual([
        "tmux_execute",
        "tmux_interactions",
        "tmux_operation_status",
        "tmux_panes",
        "tmux_prepare",
      ]);
    } finally {
      await wire.close();
    }
  });

  it("keeps preparation separate from execution and validates before effects", async () => {
    const client = fakeClient();
    const wire = await connect(client);
    try {
      await wire.rpc("tools/call", { name: "tmux_prepare", arguments: { intent } });
      expect(client.reserve).toHaveBeenCalledExactlyOnceWith(intent);
      expect(client.execute).not.toHaveBeenCalled();
      await wire.rpc("tools/call", {
        name: "tmux_execute",
        arguments: { handle, intent, command: "arbitrary" },
      });
      expect(client.execute).not.toHaveBeenCalled();
      await wire.rpc("tools/call", { name: "tmux_execute", arguments: { handle, intent } });
      expect(client.execute).toHaveBeenCalledExactlyOnceWith(handle, intent);
    } finally {
      await wire.close();
    }
  });

  it("returns uncertainty with the original handle and never silently prepares again", async () => {
    const client = fakeClient();
    client.execute.mockRejectedValue(new AutomationInvocationError("response-unconfirmed", handle));
    const wire = await connect(client);
    try {
      const response = await wire.rpc("tools/call", {
        name: "tmux_execute",
        arguments: { handle, intent },
      });
      const result = response.result as { isError: boolean; content: { text: string }[] };
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0]!.text)).toMatchObject({
        error: "response-unconfirmed",
        handle,
      });
      expect(JSON.stringify(result)).not.toContain("private");
      expect(client.reserve).not.toHaveBeenCalled();
    } finally {
      await wire.close();
    }
  });

  it("bounds an interaction wait even when the daemon never becomes ready", async () => {
    const client = fakeClient();
    const close = vi.fn();
    const resume = { server: intent.target.serverScope, cursor: 0 };
    client.subscribe.mockReturnValue({
      ready: new Promise(() => {}),
      done: new Promise(() => {}),
      close,
      getCursor: () => resume,
    });
    const wire = await connect(client);
    try {
      const response = await wire.rpc("tools/call", {
        name: "tmux_interactions",
        arguments: { resume, waitMs: 1 },
      });
      const result = response.result as { content: { text: string }[] };
      expect(JSON.parse(result.content[0]!.text)).toEqual({ cursor: resume, batch: null });
      expect(close).toHaveBeenCalledOnce();
    } finally {
      await wire.close();
    }
  });
});
