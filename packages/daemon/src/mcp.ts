import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import {
  AutomationOperationHandleSchemaZ,
  AutomationOperationIntentSchemaZ,
  TmuxInteractionCursorSchemaZ,
  type TmuxInteractionBatch,
} from "@tmux-ide/contracts";
import {
  AutomationInvocationError,
  type AutomationClient,
} from "@tmux-ide/daemon-client/automation-client";
import { localAutomationClient } from "./automation.ts";

const result = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});
async function call(work: () => Promise<unknown>) {
  try {
    return result(await work());
  } catch (error) {
    return {
      ...result(
        error instanceof AutomationInvocationError
          ? {
              error: error.code,
              handle: error.handle,
              recovery:
                "Check status or retry this exact handle. Never prepare a new operation to retry an uncertain effect.",
            }
          : { error: "automation-unavailable" },
      ),
      isError: true,
    };
  }
}

/** Closed tools only: no shell executor, arbitrary HTTP proxy or separate tmux engine. */
export function createTmuxIdeMcpServer(client: AutomationClient): McpServer {
  const server = new McpServer({ name: "tmux-ide-automation", version: "1.0.0" });
  server.registerTool(
    "tmux_panes",
    {
      description:
        "Discover current panes across this daemon's tmux servers. Use returned endpoint objects unchanged; names and native pane numbers are not unique identities.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => call(() => client.discover()),
  );
  server.registerTool(
    "tmux_prepare",
    {
      description:
        "Prepare a read or send and receive a generation-fenced operation handle. This does not send input. Save the handle before executing. A source claim requires this MCP process to hold that pane's valid credential; otherwise use source:null.",
      inputSchema: z.object({ intent: AutomationOperationIntentSchemaZ }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ intent }) => call(() => client.reserve(intent)),
  );
  server.registerTool(
    "tmux_execute",
    {
      description:
        "Execute a prepared read or send using its exact handle and unchanged intent. Sends may run terminal commands. On uncertainty, check status or retry this same handle; never prepare another operation. Read text is returned once; replay returns metadata only. A completed send is command completion, not proof the recipient consumed it.",
      inputSchema: z
        .object({
          handle: AutomationOperationHandleSchemaZ,
          intent: AutomationOperationIntentSchemaZ,
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ handle, intent }) => call(() => client.execute(handle, intent)),
  );
  server.registerTool(
    "tmux_operation_status",
    {
      description:
        "Look up a prepared operation without repeating its effect. Status contains no sent or captured text. Outcome-unknown includes expired retention and must not be interpreted as not executed.",
      inputSchema: z.object({ handle: AutomationOperationHandleSchemaZ }).strict(),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ handle }) => call(() => client.status(handle)),
  );
  server.registerTool(
    "tmux_interactions",
    {
      description:
        "Read at most one batch of scoped interaction metadata, optionally waiting for new events. Carry the returned cursor into the next call. Gaps explicitly mean missing history; these events contain no terminal contents.",
      inputSchema: z
        .object({
          resume: TmuxInteractionCursorSchemaZ,
          waitMs: z.number().int().min(1).max(30_000).default(1000),
        })
        .strict(),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ resume, waitMs }, context) =>
      call(async () => {
        let resolveBatch!: (batch: TmuxInteractionBatch | null) => void;
        const first = new Promise<TmuxInteractionBatch | null>((resolve) => {
          resolveBatch = resolve;
        });
        const subscription = client.subscribe({
          server: resume.server,
          resume,
          onBatch: (batch) => {
            resolveBatch(batch);
          },
        });
        const close = () => subscription.close();
        context.mcpReq.signal.addEventListener("abort", close, { once: true });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          context.mcpReq.signal.throwIfAborted();
          timer = setTimeout(() => resolveBatch(null), waitMs);
          // The caller's budget includes connecting to a stalled daemon.
          await Promise.race([subscription.ready, first.then(() => undefined)]);
          const batch = await Promise.race([first, subscription.done.then(() => null)]);
          context.mcpReq.signal.throwIfAborted();
          return {
            cursor: batch ? { server: resume.server, cursor: batch.cursor } : resume,
            batch,
          };
        } finally {
          clearTimeout(timer);
          context.mcpReq.signal.removeEventListener("abort", close);
          subscription.close();
        }
      }),
  );
  return server;
}

export async function runMcp(): Promise<void> {
  const client = await localAutomationClient();
  const handle = serveStdio(() => createTmuxIdeMcpServer(client), {
    transport: new StdioServerTransport(process.stdin, process.stdout, {
      maxBufferSize: 128 * 1024,
    }),
  });
  const close = () => {
    void handle.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
