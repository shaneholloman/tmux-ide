import { describe, expect, it } from "bun:test";
import type { AutomationOperationIntent } from "@tmux-ide/contracts";
import { createAutomationClient, AutomationInvocationError } from "./automation-client.ts";

const id = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const handle = { generation: id, operationId: other };
const intent: AutomationOperationIntent = {
  kind: "send",
  source: null,
  text: "private input",
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
const sent = { version: 1, handle, result: { kind: "send", submitted: true } };
function client(fetcher: typeof fetch) {
  return createAutomationClient({
    baseUrl: "http://localhost/",
    ownerToken: "owner",
    sourceCredential: "source",
    fetch: fetcher,
  });
}

describe("shared automation transport", () => {
  it("uses the declared adapter origin for both reservation and execution", async () => {
    const bodies: Record<string, unknown>[] = [];
    const api = createAutomationClient({
      baseUrl: "http://localhost",
      ownerToken: "owner",
      origin: "mcp",
      fetch: (async (url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json(String(url).endsWith("/reserve") ? { version: 1, handle } : sent);
      }) as typeof fetch,
    });
    await api.reserve(intent);
    await api.execute(handle, intent);
    expect(bodies.map((body) => body.origin)).toEqual(["mcp", "mcp"]);
  });
  it("retries uncertain execution with the exact handle/body and never reserves", async () => {
    const requests: { path: string; init?: RequestInit }[] = [];
    const api = client((async (input, init) => {
      requests.push({ path: String(input), init });
      if (requests.length === 1) throw new Error("lost response after effect");
      return Response.json(sent);
    }) as typeof fetch);
    expect(await api.execute(handle, intent)).toEqual(sent);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.init?.body).toBe(requests[1]!.init?.body);
    expect(
      requests.every(({ path }) => path === "http://localhost/api/v1/automation/execute"),
    ).toBe(true);
    expect(requests[0]!.init?.redirect).toBe("error");
    expect(requests[0]!.init?.headers).toEqual({
      Authorization: "Bearer owner",
      "Content-Type": "application/json",
      "X-Tmux-Ide-Pane-Source-Credential": "source",
    });
  });

  it("treats a daemon refusal as terminal", async () => {
    let calls = 0;
    const api = client((async () => {
      calls++;
      return Response.json({ error: { code: "operation-unavailable" } }, { status: 409 });
    }) as typeof fetch);
    await expect(api.execute(handle, intent)).rejects.toMatchObject({
      code: "operation-unavailable",
      handle,
    });
    expect(calls).toBe(1);
  });

  it("returns uncertain execution with its original handle and no private input", async () => {
    let calls = 0;
    const api = client((async () => {
      calls++;
      throw Error("private input");
    }) as typeof fetch);
    const error = await api.execute(handle, intent).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AutomationInvocationError);
    expect(error).toMatchObject({ code: "response-unconfirmed", handle });
    expect(String(error)).not.toContain(intent.text);
    expect(calls).toBe(2);
  });

  it("does not replay a lost reservation automatically", async () => {
    let calls = 0;
    const api = client((async () => {
      calls++;
      throw Error("lost");
    }) as typeof fetch);
    await expect(api.reserve(intent)).rejects.toMatchObject({
      code: "response-unconfirmed",
      handle: null,
    });
    expect(calls).toBe(1);
  });

  it("rejects response identity substitution", async () => {
    const api = client((async () =>
      Response.json({ ...sent, handle: { ...handle, generation: other } })) as typeof fetch);
    await expect(api.execute(handle, intent)).rejects.toMatchObject({
      code: "response-unconfirmed",
    });
  });

  it("rejects content in status and byte-count mismatches in snapshots", async () => {
    const api = client((async () =>
      Response.json({
        version: 1,
        handle,
        status: "completed",
        result: { kind: "send", submitted: true, text: "private" },
      })) as typeof fetch);
    await expect(api.status(handle)).rejects.toMatchObject({ code: "response-unconfirmed" });
    const badRead = client((async () =>
      Response.json({
        version: 1,
        handle,
        result: { kind: "read", capturedBytes: 1, returnedBytes: 1, truncated: false },
        read: { availability: "available", text: "not one byte" },
      })) as typeof fetch);
    await expect(
      badRead.execute(handle, { kind: "read", target: intent.target, source: null }),
    ).rejects.toMatchObject({ code: "response-unconfirmed" });
  });

  it("validates before transport and snapshots mutable request values", async () => {
    const bodies: unknown[] = [];
    const mutable = { ...intent };
    const api = client((async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json(sent);
    }) as typeof fetch);
    const pending = api.execute(handle, mutable);
    mutable.text = "changed";
    await pending;
    expect((bodies[0] as { intent: { text: string } }).intent.text).toBe("private input");
    await expect(api.execute({ ...handle, operationId: "invalid" }, intent)).rejects.toThrow();
    expect(bodies).toHaveLength(1);
  });
});

describe("automation cancellation", () => {
  it("prevents dispatch when already cancelled", async () => {
    let calls = 0;
    const controller = new AbortController();
    controller.abort();
    const api = client((async () => {
      calls++;
      return Response.json(sent);
    }) as typeof fetch);
    await expect(api.execute(handle, intent, { signal: controller.signal })).rejects.toMatchObject({
      code: "request-cancelled",
      handle,
    });
    expect(calls).toBe(0);
  });
  it("keeps the original handle and never retries cancellation after dispatch", async () => {
    let calls = 0;
    const controller = new AbortController();
    const api = client((async (_input, init) => {
      calls++;
      controller.abort();
      init?.signal?.throwIfAborted();
      return Response.json(sent);
    }) as typeof fetch);
    await expect(api.execute(handle, intent, { signal: controller.signal })).rejects.toMatchObject({
      code: "response-unconfirmed",
      handle,
    });
    expect(calls).toBe(1);
  });
  it("cancels a stalled response body without retaining or exposing received chunks", async () => {
    const controller = new AbortController();
    let cancelCount = 0;
    let connected!: () => void;
    const ready = new Promise<void>((resolve) => {
      connected = resolve;
    });
    let calls = 0;
    const api = client((async () => {
      calls++;
      return new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(new TextEncoder().encode("private partial content"));
            connected();
          },
          cancel() {
            cancelCount++;
          },
        }),
      );
    }) as typeof fetch);
    const execution = api.execute(handle, intent, { signal: controller.signal });
    await ready;
    controller.abort();
    const error = await execution.catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "response-unconfirmed", handle });
    expect(String(error)).not.toContain("private partial content");
    expect(calls).toBe(1);
    expect(cancelCount).toBe(1);
  });
});
