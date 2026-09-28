import {
  TmuxInteractionCursorSchemaZ,
  TmuxServerScopeSchemaZ,
  TmuxServerInteractionEventSchemaZ,
  type TmuxServerScope,
  type TmuxInteractionCursor,
  type TmuxInteractionBatch,
} from "@tmux-ide/contracts";

export interface TmuxInteractionSubscriptionOptions {
  readonly baseUrl: string;
  readonly ownerToken: string;
  readonly server: TmuxServerScope;
  readonly resume?: TmuxInteractionCursor;
  readonly fetch?: typeof fetch;
  readonly readinessTimeoutMs?: number;
  readonly onBatch: (batch: TmuxInteractionBatch, signal: AbortSignal) => void | Promise<void>;
}
export interface TmuxInteractionSubscription {
  readonly ready: Promise<void>;
  readonly done: Promise<void>;
  getCursor(): TmuxInteractionCursor;
  close(): void;
}
/** One scoped connection. The caller owns reconnect policy and carries this exact cursor scope. */
export function subscribeTmuxServerInteractions(
  options: TmuxInteractionSubscriptionOptions,
): TmuxInteractionSubscription {
  const server = TmuxServerScopeSchemaZ.parse(options.server);
  const resume = options.resume
    ? TmuxInteractionCursorSchemaZ.parse(options.resume)
    : { server, cursor: 0 };
  if (resume.server.serverId !== server.serverId || resume.server.generation !== server.generation)
    throw new Error("Receipt resume cursor belongs to another owner");
  let cursor = resume.cursor;
  let opened = false;
  let closed = false;
  const lifetime = new AbortController();
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // Consumers may wait on done before ready; keep the readiness rejection handled.
  void ready.catch(() => undefined);
  const timer = setTimeout(
    () => lifetime.abort(new Error("Receipt stream readiness timed out")),
    options.readinessTimeoutMs ?? 5000,
  );
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  lifetime.signal.addEventListener(
    "abort",
    () => {
      void reader?.cancel().catch(() => undefined);
    },
    { once: true },
  );
  const done = (async () => {
    try {
      const response = await (options.fetch ?? fetch)(
        `${options.baseUrl.replace(/\/+$/u, "")}/api/v1/tmux-servers/${server.serverId}/${server.generation}/interaction-events?after=${cursor}`,
        {
          headers: { Authorization: `Bearer ${options.ownerToken}` },
          redirect: "error",
          cache: "no-store",
          signal: lifetime.signal,
        },
      );
      if (!response.ok || !response.body)
        throw new Error(`Receipt stream unavailable (${response.status})`);
      reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let buffer = "";
      while (!closed) {
        const next = await reader.read();
        if (next.done) throw new Error("Receipt stream disconnected");
        buffer += decoder.decode(next.value, { stream: true });
        if (buffer.length > 1024 * 1024) throw new Error("Receipt frame exceeds size limit");
        for (;;) {
          const end = buffer.indexOf("\n\n");
          if (end < 0) break;
          const event = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = event
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (!data) continue;
          const frame = TmuxServerInteractionEventSchemaZ.parse(JSON.parse(data));
          if (
            frame.server.serverId !== server.serverId ||
            frame.server.generation !== server.generation
          )
            throw new Error("Receipt stream owner mismatch");
          if (frame.type === "retired") throw new Error("Receipt owner retired");
          if (!opened) {
            if (frame.type !== "ready" || frame.after !== cursor)
              throw new Error("Missing receipt readiness barrier");
            opened = true;
            clearTimeout(timer);
            resolveReady();
          } else {
            if (frame.type !== "batch" || frame.after !== cursor)
              throw new Error("Repeated or regressed receipt frame");
            // A consumer may stall indefinitely. Closing the subscription must
            // still release its transport without acknowledging unfinished work.
            let onAbort: (() => void) | undefined;
            try {
              await Promise.race([
                Promise.resolve().then(() => {
                  lifetime.signal.throwIfAborted();
                  return options.onBatch(frame, lifetime.signal);
                }),
                new Promise<never>((_, reject) => {
                  onAbort = () => reject(lifetime.signal.reason);
                  if (lifetime.signal.aborted) onAbort();
                  else lifetime.signal.addEventListener("abort", onAbort, { once: true });
                }),
              ]);
            } finally {
              if (onAbort) lifetime.signal.removeEventListener("abort", onAbort);
            }
            lifetime.signal.throwIfAborted();
            cursor = frame.cursor;
            if (closed) break;
          }
        }
      }
    } catch (error) {
      rejectReady(error);
      if (!closed) throw error;
    } finally {
      clearTimeout(timer);
      lifetime.abort();
      await reader?.cancel().catch(() => undefined);
      reader?.releaseLock();
    }
  })();
  void done.catch(() => undefined);
  return {
    ready,
    done,
    getCursor: () => ({ server: { ...server }, cursor }),
    close() {
      closed = true;
      rejectReady(new Error("Receipt subscription closed"));
      lifetime.abort();
    },
  };
}
