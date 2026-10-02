import {
  AUTOMATION_API_PATH,
  AutomationErrorResponseSchemaZ,
  AutomationExecuteRequestSchemaZ,
  AutomationExecuteResponseSchemaZ,
  AutomationOperationHandleSchemaZ,
  AutomationPanesResponseSchemaZ,
  AutomationReserveRequestSchemaZ,
  AutomationReserveResponseSchemaZ,
  AutomationStatusResponseSchemaZ,
  type AutomationOperationHandle,
  type AutomationOperationIntent,
} from "@tmux-ide/contracts";
import {
  subscribeTmuxServerInteractions,
  type TmuxInteractionSubscriptionOptions,
} from "./tmux-server-interaction-events.ts";

export interface AutomationRequestOptions {
  readonly signal?: AbortSignal;
}

export interface AutomationClientOptions {
  readonly origin?: "cli" | "sdk" | "mcp";
  readonly baseUrl: string;
  readonly ownerToken: string;
  readonly sourceCredential?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/** A failed response is never permission to reserve and submit a new operation. */
export class AutomationInvocationError extends Error {
  constructor(
    readonly code: string,
    readonly handle: AutomationOperationHandle | null,
  ) {
    super(
      handle
        ? `Automation operation ${handle.operationId}: ${code}. Check status; do not repeat with a new handle.`
        : `Automation request failed: ${code}`,
    );
    this.name = "AutomationInvocationError";
  }
}

async function boundedResponse(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<unknown> {
  if (!response.body) throw new Error("Missing automation response");
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    signal.throwIfAborted();
    for (;;) {
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) throw new Error("Automation response exceeds bound");
      chunks.push(next.value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

/** Shared closed transport for CLI, SDK and MCP. Daemon authority owns effects. */
export function createAutomationClient(options: AutomationClientOptions) {
  const origin = options.origin ?? "sdk";
  const baseUrl = options.baseUrl.replace(/\/+$/u, "");
  const requestFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new TypeError("Invalid automation request timeout");
  const headers = {
    Authorization: `Bearer ${options.ownerToken}`,
    "Content-Type": "application/json",
    ...(options.sourceCredential
      ? { "X-Tmux-Ide-Pane-Source-Credential": options.sourceCredential }
      : {}),
  };

  async function request<T>(
    path: "/panes" | "/reserve" | "/execute" | `/operations/${string}/${string}`,
    schema: { parse(value: unknown): T },
    body?: unknown,
    handle: AutomationOperationHandle | null = null,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) throw new AutomationInvocationError("request-cancelled", handle);
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    let dispatched = false;
    // Reservation is single-shot. Only execution retries, with the exact minted
    // handle/body; expiry and restart are terminal daemon refusals.
    const attempts = path === "/execute" ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        signal?.throwIfAborted();
        const requestSignal = signal
          ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs);
        dispatched = true;
        const response = await requestFetch(`${baseUrl}${AUTOMATION_API_PATH}${path}`, {
          method: serialized === undefined ? "GET" : "POST",
          headers,
          body: serialized,
          signal: requestSignal,
          redirect: "error",
          cache: "no-store",
        });
        const result = await boundedResponse(
          response,
          path === "/panes" ? 8 * 1024 * 1024 : 128 * 1024,
          requestSignal,
        );
        const failure = AutomationErrorResponseSchemaZ.safeParse(result);
        if (failure.success) throw new AutomationInvocationError(failure.data.error.code, handle);
        if (!response.ok) throw new Error("Invalid automation response");
        const parsed = schema.parse(result);
        if (handle) {
          const received = AutomationOperationHandleSchemaZ.parse(
            (parsed as { handle?: unknown }).handle,
          );
          if (
            received.operationId !== handle.operationId ||
            received.generation !== handle.generation
          )
            throw new Error("Automation response handle mismatch");
        }
        return parsed;
      } catch (error) {
        if (signal?.aborted)
          throw new AutomationInvocationError(
            dispatched ? "response-unconfirmed" : "request-cancelled",
            handle,
          );
        if (error instanceof AutomationInvocationError) throw error;
        if (attempt + 1 === attempts)
          throw new AutomationInvocationError("response-unconfirmed", handle);
      }
    }
    throw new AutomationInvocationError("response-unconfirmed", handle);
  }

  return {
    discover: (requestOptions: AutomationRequestOptions = {}) =>
      request("/panes", AutomationPanesResponseSchemaZ, undefined, null, requestOptions.signal),
    reserve(intent: AutomationOperationIntent, requestOptions: AutomationRequestOptions = {}) {
      return request(
        "/reserve",
        AutomationReserveResponseSchemaZ,
        AutomationReserveRequestSchemaZ.parse({ version: 1, intent, origin }),
        null,
        requestOptions.signal,
      );
    },
    async execute(
      handle: AutomationOperationHandle,
      intent: AutomationOperationIntent,
      requestOptions: AutomationRequestOptions = {},
    ) {
      const parsed = AutomationExecuteRequestSchemaZ.parse({ version: 1, handle, intent, origin });
      const result = await request(
        "/execute",
        AutomationExecuteResponseSchemaZ,
        parsed,
        parsed.handle,
        requestOptions.signal,
      );
      if (result.result.kind !== parsed.intent.kind)
        throw new AutomationInvocationError("response-unconfirmed", parsed.handle);
      return result;
    },
    status(handle: AutomationOperationHandle, requestOptions: AutomationRequestOptions = {}) {
      const parsed = AutomationOperationHandleSchemaZ.parse(handle);
      return request(
        `/operations/${parsed.generation}/${parsed.operationId}`,
        AutomationStatusResponseSchemaZ,
        undefined,
        parsed,
        requestOptions.signal,
      );
    },
    subscribe(
      options: Omit<TmuxInteractionSubscriptionOptions, "baseUrl" | "ownerToken" | "fetch">,
    ) {
      return subscribeTmuxServerInteractions({
        ...options,
        baseUrl,
        ownerToken: headers.Authorization.slice(7),
        fetch: requestFetch,
      });
    },
  };
}

export type AutomationClient = ReturnType<typeof createAutomationClient>;
