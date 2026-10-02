// Copied into the clean consumer directory: imports must resolve from the tarball.
import { createTmuxIdeAutomationSdk } from "@tmux-ide/sdk";

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const generation = "11111111-1111-4111-8111-111111111111";
const target = {
  kind: "pane",
  environmentId: generation,
  serverScope: { serverId: `tmux-server.${"a".repeat(32)}`, generation },
  paneLifetimeId: generation,
  workspaceName: "workspace.project",
  semanticPaneId: "pane.editor",
};
const reservations = new Map();
let effects = 0;
let executions = 0;
let loseSendResponse = true;
const sdk = createTmuxIdeAutomationSdk({
  baseUrl: "http://localhost:4000",
  ownerToken: "owner",
  sourceCredential: "source",
  fetch: async (url, init) => {
    check(init.headers.Authorization === "Bearer owner", "Owner header lost");
    check(init.headers["X-Tmux-Ide-Pane-Source-Credential"] === "source", "Source header lost");
    const path = new URL(url).pathname;
    if (path.endsWith("/panes"))
      return Response.json({
        version: 1,
        panes: [{ endpoint: target, title: "Editor", sessionName: "dev" }],
      });
    const body = init.body ? JSON.parse(init.body) : null;
    if (body) check(body.origin === "sdk", "Incorrect SDK origin");
    if (path.endsWith("/reserve")) {
      const operationId = `22222222-2222-4222-8222-${String(reservations.size + 1).padStart(12, "0")}`;
      const handle = { generation, operationId };
      reservations.set(operationId, { handle, intent: JSON.stringify(body.intent) });
      return Response.json({ version: 1, handle });
    }
    const entry = reservations.get(body?.handle.operationId ?? path.split("/").at(-1));
    check(!!entry, "Unknown operation");
    if (path.endsWith("/execute")) {
      executions++;
      check(JSON.stringify(body.intent) === entry.intent, "Retry changed the reserved intent");
      if (!entry.result) {
        if (body.intent.kind === "send") {
          effects++;
          entry.result = { kind: "send", submitted: true };
        } else {
          entry.result = { kind: "read", capturedBytes: 3, returnedBytes: 3, truncated: false };
        }
      }
      if (body.intent.kind === "send" && loseSendResponse) {
        loseSendResponse = false;
        throw new Error("Simulated response loss after effect");
      }
      return Response.json({
        version: 1,
        handle: entry.handle,
        result: entry.result,
        ...(entry.result.kind === "read"
          ? { read: { availability: "available", text: "ok\n" } }
          : {}),
      });
    }
    check(path.includes("/operations/"), "Unexpected route");
    return Response.json({
      version: 1,
      handle: entry.handle,
      status: "completed",
      result: entry.result,
    });
  },
});
const discovered = await sdk.discover();
check(discovered.panes[0].endpoint.semanticPaneId === target.semanticPaneId, "Discovery failed");
for (const intent of [
  { kind: "read", target, source: null },
  { kind: "send", target, source: null, text: "hello", enter: true },
]) {
  const { handle } = await sdk.reserve(intent);
  const result = await sdk.execute(handle, intent);
  check(result.result.kind === intent.kind, "Execution failed");
  if (intent.kind === "read") check(result.read.text === "ok\n", "Snapshot lost");
  const status = await sdk.status(handle);
  check(status.status === "completed" && status.result.kind === intent.kind, "Status failed");
  check(!("read" in status), "Status exposed captured content");
}
check(reservations.size === 2 && effects === 1 && executions === 3, "Retry/reservation mismatch");
const incompatible = createTmuxIdeAutomationSdk({
  baseUrl: "http://localhost:4000",
  ownerToken: "owner",
  fetch: async () => Response.json({ version: 2, panes: [] }),
});
await incompatible.discover().then(
  () => {
    throw new Error("Accepted incompatible response");
  },
  (error) => check(error.code === "response-unconfirmed", "Incorrect incompatibility failure"),
);
