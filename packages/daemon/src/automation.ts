import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import {
  AutomationExecuteRequestSchemaZ,
  AutomationOperationHandleSchemaZ,
  AutomationOperationIntentSchemaZ,
  TmuxInteractionCursorSchemaZ,
  type AutomationOperationHandle,
} from "@tmux-ide/contracts";
import {
  createAutomationClient,
  AutomationInvocationError,
  type AutomationClient,
} from "@tmux-ide/daemon-client/automation-client";
import {
  canonicalDaemonUrl,
  isCanonicalDaemonAlive,
  readCanonicalDaemonInfo,
} from "./lib/canonical-daemon.ts";
import { PANE_SOURCE_CREDENTIAL_OPTION } from "./lib/pane-source-credentials.ts";
import { IdeError } from "./lib/errors.ts";

/** Source credentials are read from the invoking pane's actual server, never the target server. */
export function invokingPaneCredential(env = process.env): string | undefined {
  const tmux = env.TMUX;
  const pane = env.TMUX_PANE;
  if (!tmux || !pane || !/^%\d+$/u.test(pane)) return undefined;
  const match = /^(\/[^\0\r\n]+),\d+,\d+$/u.exec(tmux);
  if (!match) return undefined;
  try {
    const value = execFileSync(
      "tmux",
      ["-S", match[1]!, "show-option", "-p", "-v", "-t", pane, PANE_SOURCE_CREDENTIAL_OPTION],
      {
        encoding: "utf8",
        timeout: 1500,
        maxBuffer: 256,
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    return /^[A-Za-z0-9_-]{32,128}$/u.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function localAutomationClient(): Promise<AutomationClient> {
  const daemon = readCanonicalDaemonInfo();
  if (!daemon?.authToken || !(await isCanonicalDaemonAlive(daemon)))
    throw new IdeError("A running compatible tmux-ide daemon is required for automation", {
      code: "AUTOMATION_UNAVAILABLE",
    });
  return createAutomationClient({
    baseUrl: canonicalDaemonUrl("http", daemon.bindHostname, daemon.port),
    ownerToken: daemon.authToken,
    sourceCredential: invokingPaneCredential(),
  });
}

class AutomationCliError extends IdeError {
  constructor(error: AutomationInvocationError) {
    super(error.message, { code: error.code });
    this.handle = error.handle;
  }
  readonly handle: AutomationOperationHandle | null;
  override toJSON() {
    return { ...super.toJSON(), handle: this.handle };
  }
}

export async function readAutomationRequest(
  input: AsyncIterable<Uint8Array | string>,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 64 * 1024)
      throw new IdeError("Automation request exceeds 64 KiB", { code: "INVALID_REQUEST" });
    chunks.push(bytes);
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new IdeError("Expected a JSON automation request on stdin", { code: "INVALID_REQUEST" });
  }
}

/** The CLI is a thin adapter; it never falls back to raw tmux after an uncertain effect. */
export async function runAutomationCli(
  args: readonly string[],
  dependencies: {
    client?: AutomationClient;
    input?: AsyncIterable<Uint8Array | string>;
    output?: (value: unknown) => void;
  } = {},
): Promise<void> {
  const { positionals, values } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: { json: { type: "boolean" }, help: { type: "boolean", short: "h" } },
  });
  const output =
    dependencies.output ?? ((value) => process.stdout.write(`${JSON.stringify(value)}\n`));
  const command = positionals[0];
  if (values.help || !command) {
    output({
      usage: "tmux-ide automation panes|reserve|execute|send|read|status|events --json",
      input:
        "reserve/send/read: intent JSON on stdin; execute: {version:1,handle,intent}; status: generation operationId; events: {server,cursor}",
    });
    return;
  }
  if (!["panes", "reserve", "execute", "send", "read", "status", "events"].includes(command))
    throw new IdeError("Unknown automation command", { code: "INVALID_REQUEST" });
  const client = dependencies.client ?? (await localAutomationClient());
  try {
    if (command === "panes") {
      output(await client.discover());
      return;
    }
    if (command === "status") {
      output(
        await client.status(
          AutomationOperationHandleSchemaZ.parse({
            generation: positionals[1],
            operationId: positionals[2],
          }),
        ),
      );
      return;
    }
    if (!dependencies.input && process.stdin.isTTY)
      throw new IdeError("Provide the JSON automation request on stdin", {
        code: "INVALID_REQUEST",
      });
    const input = await readAutomationRequest(dependencies.input ?? process.stdin);
    if (command === "execute") {
      const request = AutomationExecuteRequestSchemaZ.parse(input);
      output(await client.execute(request.handle, request.intent));
      return;
    }
    if (command === "events") {
      const resume = TmuxInteractionCursorSchemaZ.parse(input);
      const subscription = client.subscribe({
        server: resume.server,
        resume,
        onBatch: (batch) => output(batch),
      });
      const close = () => subscription.close();
      process.once("SIGINT", close);
      process.once("SIGTERM", close);
      try {
        await subscription.ready;
        await subscription.done;
      } finally {
        subscription.close();
        process.off("SIGINT", close);
        process.off("SIGTERM", close);
      }
      return;
    }
    const intent = AutomationOperationIntentSchemaZ.parse(input);
    if (command !== "reserve" && intent.kind !== command)
      throw new IdeError("Automation command does not match intent kind", {
        code: "INVALID_REQUEST",
      });
    const reservation = await client.reserve(intent);
    if (command === "reserve") output(reservation);
    else output(await client.execute(reservation.handle, intent));
  } catch (error) {
    if (error instanceof AutomationInvocationError) throw new AutomationCliError(error);
    throw error;
  }
}
