import { createServer, type ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import {
  createAutomationClient,
  type AutomationClient,
} from "@tmux-ide/daemon-client/automation-client";
import {
  AutomationPanesResponseSchemaZ,
  AutomationReserveResponseSchemaZ,
  AutomationExecuteResponseSchemaZ,
  AutomationStatusResponseSchemaZ,
  type AutomationOperationIntent,
} from "@tmux-ide/contracts";
import { createTmuxIdeMcpServer } from "./mcp.ts";
import { mountAutomationRoutes } from "./command-center/automation.ts";
import {
  createNativeTmuxServerOwner,
  type NativeTmuxServerOwner,
} from "./lib/tmux-server-owner.ts";
import { TmuxServerOwners } from "./lib/tmux-server-owners.ts";
import { createTmuxServerProbe } from "./lib/tmux-server-registration.ts";
import { PANE_SOURCE_CREDENTIAL_OPTION } from "./lib/pane-source-credentials.ts";

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
    cancelLatest: () =>
      input.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: sequence } })}\n`,
      ),
    close: async () => {
      await server.close();
      input.destroy();
      output.destroy();
    },
  };
}

function toolValue(response: Record<string, unknown>): unknown {
  const result = response.result as { content: { type: string; text: string }[] };
  expect(result.content[0]?.type).toBe("text");
  return JSON.parse(result.content[0]!.text);
}
const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
it.skipIf(!hasTmux)(
  "MCP stdio reaches real HTTP owners and retries only the same committed handle",
  async () => {
    const root = realpathSync(mkdtempSync("/tmp/tmux-mcp-live-"));
    const executable = realpathSync(execFileSync("which", ["tmux"], { encoding: "utf8" }).trim());
    const sockets = [join(root, "target.sock"), join(root, "source.sock")];
    const run = (socket: string, args: string[]) =>
      execFileSync(executable, ["-S", socket, "-f", "/dev/null", ...args], {
        encoding: "utf8",
        env: { ...process.env, TMUX: "" },
      }).trim();
    const created: NativeTmuxServerOwner[] = [];
    const owners = new TmuxServerOwners<NativeTmuxServerOwner>({
      probe: createTmuxServerProbe(executable),
      create: async (registration, scope, observation) => {
        const owner = await createNativeTmuxServerOwner({
          ...scope,
          environmentId: "00000000-0000-4000-8000-000000000001",
          tmuxAuthority: observation.authority,
          nativeServerIdentity: observation.nativeServerIdentity,
          stateDirectory: join(root, registration.serverId),
          webSocketUrl: "ws://127.0.0.1:45678/v2/terminal/pane-streams/redeem",
        });
        created.push(owner);
        return owner;
      },
    });
    const app = new Hono();
    mountAutomationRoutes(app, { ownerToken: "owner", owners });
    const executionRequests: { operationId: string; generation: string; origin: string }[] = [];
    const preparedHandles: string[] = [];
    let reserveRequests = 0;
    let disrupt: "drop" | "hold" | null = null;
    let committedResponse: ServerResponse | null = null;
    const server = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of req) {
          const data = Buffer.from(chunk);
          bytes += data.length;
          if (bytes > 128 * 1024) throw new Error("request bound");
          chunks.push(data);
        }
        if (req.url?.endsWith("/reserve")) reserveRequests++;
        if (req.url?.endsWith("/execute")) {
          const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            handle: { operationId: string; generation: string };
            origin: string;
          };
          executionRequests.push({
            operationId: request.handle.operationId,
            generation: request.handle.generation,
            origin: request.origin,
          });
        }
        const response = await app.request(`http://127.0.0.1${req.url}`, {
          method: req.method,
          headers: req.headers as Record<string, string>,
          ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
        });
        const data = Buffer.from(await response.arrayBuffer());
        if (req.url?.endsWith("/execute") && response.ok && disrupt) {
          const mode = disrupt;
          disrupt = null;
          committedResponse = res;
          if (mode === "drop") res.destroy();
          return;
        }
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(data);
      } catch {
        res.destroy();
      }
    });
    const wires: Awaited<ReturnType<typeof connect>>[] = [];
    try {
      const targetFile = join(root, "received");
      writeFileSync(targetFile, "");
      writeFileSync(join(root, "source-input"), "");
      const program = join(root, "terminal.py");
      writeFileSync(
        program,
        `import os,sys,termios
a=termios.tcgetattr(0);a[3]&=~termios.ECHO;termios.tcsetattr(0,termios.TCSANOW,a)
os.write(1,b'READ_PRIVATE_SENTINEL\\n')
for line in sys.stdin.buffer:
 with open(sys.argv[1],'ab') as f:f.write(line)
 os.write(1,line)
`,
      );
      for (const socket of sockets) {
        run(socket, [
          "new-session",
          "-d",
          "-s",
          "shared",
          `python3 '${program}' '${socket === sockets[0] ? targetFile : join(root, "source-input")}'`,
        ]);
        run(socket, ["set-option", "-p", "-t", "shared:0.0", "@tmux_ide_pane_id", "pane.shared"]);
        await owners.register({ label: "test", selector: { kind: "path", path: socket } });
      }
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing HTTP port");
      let credential: string | undefined;
      const client = () =>
        createAutomationClient({
          baseUrl: `http://127.0.0.1:${address.port}`,
          ownerToken: "owner",
          sourceCredential: credential,
          origin: "mcp",
        });
      const open = async () => {
        const wire = await connect(client());
        wires.push(wire);
        return wire;
      };
      let wire = await open();
      const callTool = (name: string, args: unknown) =>
        wire.rpc("tools/call", { name, arguments: args });
      const discovered = AutomationPanesResponseSchemaZ.parse(
        toolValue(await callTool("tmux_panes", {})),
      );
      expect(discovered.panes).toHaveLength(2);
      const target = discovered.panes.find(
        (p) => p.endpoint.serverScope.serverId === created[0]!.serverId,
      )!.endpoint;
      const source = discovered.panes.find(
        (p) => p.endpoint.serverScope.serverId === created[1]!.serverId,
      )!.endpoint;
      credential = run(sockets[1]!, [
        "show-options",
        "-p",
        "-v",
        "-t",
        "shared:0.0",
        PANE_SOURCE_CREDENTIAL_OPTION,
      ]);
      await wire.close();
      wire = await open();
      for (const mode of ["drop", "cancel", "disconnect"] as const) {
        const text = `MCP_PRIVATE_${mode}`;
        const intent: AutomationOperationIntent = {
          kind: "send",
          target,
          source,
          text,
          enter: true,
        };
        const prepared = AutomationReserveResponseSchemaZ.parse(
          toolValue(await callTool("tmux_prepare", { intent })),
        );
        preparedHandles.push(JSON.stringify(prepared.handle));
        disrupt = mode === "drop" ? "drop" : "hold";
        committedResponse = null;
        const pending = callTool("tmux_execute", { handle: prepared.handle, intent });
        await vi.waitFor(() => expect(committedResponse).not.toBeNull());
        if (mode === "cancel") {
          wire.cancelLatest();
          await vi.waitFor(() => expect(committedResponse!.destroyed).toBe(true));
        } else if (mode === "disconnect") {
          await wire.close();
          wire = await open();
        } else {
          expect(AutomationExecuteResponseSchemaZ.parse(toolValue(await pending)).handle).toEqual(
            prepared.handle,
          );
        }
        committedResponse!.destroy();
        const retried = AutomationExecuteResponseSchemaZ.parse(
          toolValue(await callTool("tmux_execute", { handle: prepared.handle, intent })),
        );
        expect(retried.handle).toEqual(prepared.handle);
        const attempts = executionRequests.filter(
          (request) => request.operationId === prepared.handle.operationId,
        );
        expect(attempts.length).toBeGreaterThanOrEqual(2);
        expect(attempts.every((request) => request.origin === "mcp")).toBe(true);
        const status = AutomationStatusResponseSchemaZ.parse(
          toolValue(await callTool("tmux_operation_status", { handle: prepared.handle })),
        );
        expect(status.status).toBe("completed");
        expect(JSON.stringify(status)).not.toContain(text);
        await vi.waitFor(() =>
          expect(
            readFileSync(targetFile, "utf8")
              .split("\n")
              .filter((line) => line === text),
          ).toHaveLength(1),
        );
        const receipts = created[0]!.interactionReceipts.read(0).receipts;
        expect(
          receipts.filter(
            (r) =>
              r.type === "interaction.receipt" &&
              r.operationId === prepared.handle.operationId &&
              r.phase === "observed",
          ),
        ).toHaveLength(1);
        const observed = receipts.find(
          (r) =>
            r.type === "interaction.receipt" &&
            r.operationId === prepared.handle.operationId &&
            r.phase === "observed",
        );
        expect(observed).toMatchObject({
          origin: "mcp",
          evidence: { actor: { kind: "cooperative" }, endpoints: { source, destination: target } },
        });
        expect(JSON.stringify(receipts)).not.toContain(text);
        expect(
          created[1]!.interactionReceipts
            .read(0)
            .receipts.some(
              (r) =>
                r.type === "interaction.receipt" && r.operationId === prepared.handle.operationId,
            ),
        ).toBe(false);
      }
      const intent: AutomationOperationIntent = { kind: "read", target, source };
      const prepared = AutomationReserveResponseSchemaZ.parse(
        toolValue(await callTool("tmux_prepare", { intent })),
      );
      preparedHandles.push(JSON.stringify(prepared.handle));
      const first = AutomationExecuteResponseSchemaZ.parse(
        toolValue(await callTool("tmux_execute", { handle: prepared.handle, intent })),
      );
      expect(first.read?.text).toContain("READ_PRIVATE_SENTINEL");
      const replay = AutomationExecuteResponseSchemaZ.parse(
        toolValue(await callTool("tmux_execute", { handle: prepared.handle, intent })),
      );
      expect(replay.read).toEqual({ availability: "replay-unavailable", text: null });
      const readReceipt = created[0]!.interactionReceipts
        .read(0)
        .receipts.find(
          (receipt) =>
            receipt.type === "interaction.receipt" &&
            receipt.operationId === prepared.handle.operationId &&
            receipt.phase === "observed",
        );
      expect(readReceipt).toMatchObject({
        origin: "mcp",
        operationKind: "workspace.pane.read",
        evidence: { endpoints: { source, destination: target } },
      });
      const readStatus = toolValue(
        await callTool("tmux_operation_status", { handle: prepared.handle }),
      );
      expect(readStatus).toMatchObject({ status: "completed" });
      expect(JSON.stringify(readStatus)).not.toContain("READ_PRIVATE_SENTINEL");
      expect(reserveRequests).toBe(4);
      expect(preparedHandles).toHaveLength(4);
      expect(new Set(preparedHandles).size).toBe(4);
      expect(
        new Set(
          executionRequests.map(({ generation, operationId }) =>
            JSON.stringify({ generation, operationId }),
          ),
        ),
      ).toEqual(new Set(preparedHandles));
      expect(executionRequests.every((request) => request.origin === "mcp")).toBe(true);
      expect(readFileSync(targetFile, "utf8")).toBe(
        "MCP_PRIVATE_drop\nMCP_PRIVATE_cancel\nMCP_PRIVATE_disconnect\n",
      );
      expect(readFileSync(join(root, "source-input"), "utf8")).toBe("");
      expect(JSON.stringify(created[0]!.interactionReceipts.read(0))).not.toContain(
        "READ_PRIVATE_SENTINEL",
      );
    } finally {
      committedResponse?.destroy();
      for (const wire of wires) await wire.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await owners.dispose();
      for (const socket of sockets)
        spawnSync(executable, ["-S", socket, "kill-server"], {
          stdio: "ignore",
          env: { ...process.env, TMUX: "" },
        });
      rmSync(root, { recursive: true, force: true });
    }
  },
  30000,
);
