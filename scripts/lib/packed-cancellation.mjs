import { execFile } from "node:child_process";

/** Cooperative fixture cancellation. Never kills an npm/compiler process tree by inference. */
export function createPackedCancellation({ signals = process, commandKillGraceMs = 1000 } = {}) {
  const controller = new AbortController();
  const commands = [];
  let cleanupDepth = 0,
    cancelledAt = null,
    receivedSignal = null,
    uncertainCommand = false;
  const cancel = (name) => {
    if (!controller.signal.aborted) {
      receivedSignal = name;
      cancelledAt = Date.now();
      controller.abort(new Error("Packed qualification cancelled"));
    }
  };
  const onInt = () => cancel("SIGINT"),
    onTerm = () => cancel("SIGTERM");
  signals.on("SIGINT", onInt);
  signals.on("SIGTERM", onTerm);
  const check = () => {
    if (!cleanupDepth) controller.signal.throwIfAborted();
  };
  const waitFor = async (promise, timeoutMs = 10000) => {
    check();
    let timer, abort;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Packed fixture wait deadline exceeded")),
            timeoutMs,
          );
          abort = () => reject(controller.signal.reason);
          if (!cleanupDepth) controller.signal.addEventListener("abort", abort, { once: true });
        }),
      ]);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", abort);
    }
  };
  return {
    check,
    waitFor,
    signal: () => (cleanupDepth ? undefined : controller.signal),
    async pause(ms) {
      let timer;
      try {
        await waitFor(
          new Promise((r) => {
            timer = setTimeout(r, ms);
          }),
          ms + 1000,
        );
      } finally {
        clearTimeout(timer);
      }
    },
    async cleanup(work) {
      cleanupDepth++;
      try {
        return await work();
      } finally {
        cleanupDepth--;
      }
    },
    beginCleanup() {
      cleanupDepth++;
    },
    facts() {
      return {
        requested: controller.signal.aborted,
        signal: receivedSignal,
        sinceRequestMs: cancelledAt === null ? null : Date.now() - cancelledAt,
        uncertainCommand,
        commands: commands.map((entry) => ({ ...entry })),
      };
    },
    async command(file, args, options = {}) {
      check();
      let child;
      let escalation;
      let deadline;
      let escalated = false;
      let exceededDeadline = false;
      const result = await new Promise((resolve) => {
        child = execFile(
          file,
          args,
          {
            ...options,
            encoding: "utf8",
            timeout: 0, // The retained-handle deadline below owns TERM/KILL ordering.
            maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
          },
          (error, stdout, stderr) => {
            clearTimeout(escalation);
            clearTimeout(deadline);
            error ??= exceededDeadline
              ? new Error("Packed command did not close before deadline")
              : undefined;
            resolve({
              status: error ? (typeof error.code === "number" ? error.code : null) : 0,
              signal: error?.signal ?? null,
              error: error ?? undefined,
              stdout,
              stderr,
            });
          },
        );
        // Own the deadline: execFile can report exit 0 after destroying pipes
        // held by a descendant at its timeout. That is not a completed command.
        deadline = setTimeout(() => {
          exceededDeadline = true;
          uncertainCommand = true;
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
          else {
            child.stdout?.destroy();
            child.stderr?.destroy();
          }
          escalation = setTimeout(() => {
            escalated = true;
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            else {
              child.stdout?.destroy();
              child.stderr?.destroy();
            }
          }, commandKillGraceMs);
        }, options.timeout ?? 180000);
        child.once("exit", () => {
          if (!escalated) return;
          // An inherited pipe must not keep execFile waiting after root exit.
          // Do not infer authority to signal an unidentified descendant.
          child.stdout?.destroy();
          child.stderr?.destroy();
        });
        if (options.stdio === "inherit") {
          child.stdout?.pipe(process.stdout, { end: false });
          child.stderr?.pipe(process.stderr, { end: false });
        }
      });
      // execFile callback settles after close. Timeout/buffer termination does not
      // prove descendants stopped; retain roots and make the final receipt refuse.
      if (
        result.error &&
        (result.error.killed || result.error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
      )
        uncertainCommand = true;
      commands.push({
        pid: child.pid ?? null,
        status: result.status,
        signal: result.signal,
        settled: true,
      });
      check();
      return { ...result, pid: child.pid ?? null };
    },
    dispose() {
      signals.removeListener("SIGINT", onInt);
      signals.removeListener("SIGTERM", onTerm);
    },
  };
}
