import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";
import {
  NativeJournalCapabilitySchemaZ,
  NativeJournalIdentitySchemaZ,
  NativeJournalCursorSchemaZ,
  type NativeJournalCursor,
} from "@tmux-ide/contracts";
import { parseControlLine } from "../terminal/protocol/control.ts";
import type { WorkspacePaneTmuxAuthority } from "./workspace-pane-creation.ts";

const MAX_REPLY_BYTES = 65_536;
type Pending = {
  flags: number;
  maxLines: number;
  resolve: (lines: string[]) => void;
  reject: (error: Error) => void;
};

/** A sessionless metadata peer: one process, one request, no command or effect queue. */
export class NativeJournalControlConnection {
  readonly #authority: WorkspacePaneTmuxAuthority;
  readonly #serverEpoch: string;
  #process: ChildProcessWithoutNullStreams | null = null;
  #exited: Promise<void> = Promise.resolve();
  #pending: Pending | null = null;
  #frame: { num: number; flags: number; lines: string[]; bytes: number } | null = null;
  #buffer = "";
  #stderrBytes = 0;
  #failure: Error | null = null;
  #starting: Promise<void> | null = null;
  #disposing: Promise<void> | null = null;
  #connectionId: string | null = null;

  constructor(authority: WorkspacePaneTmuxAuthority, serverEpoch: string) {
    this.#authority = structuredClone(authority);
    this.#serverEpoch = NativeJournalCursorSchemaZ.parse({
      serverEpoch,
      journalEpoch: serverEpoch,
      sequence: "0",
    }).serverEpoch;
  }

  get connectionId(): string | null {
    return this.#connectionId;
  }

  async start(signal: AbortSignal): Promise<void> {
    return (this.#starting ??= this.#open(signal));
  }

  async #open(signal: AbortSignal): Promise<void> {
    const selector = this.#authority.socketSelector;
    const address = selector.kind === "path" ? selector.path : selector.name;
    if (
      /[\0\r\n]/u.test(address) ||
      (selector.kind === "path"
        ? !isAbsolute(address)
        : !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(address))
    )
      throw new Error("Invalid native journal socket authority");
    const lines = await this.#receive(0, 2, signal, () => {
      const child = spawn(
        this.#authority.executablePath,
        ["-N", "-C", selector.kind === "path" ? "-S" : "-L", address, "tmux-ide-events", "-P"],
        { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, TMUX: "" } },
      );
      this.#process = child;
      this.#exited = new Promise((resolve) => {
        child.once("close", () => {
          this.#fail("Native journal peer closed");
          resolve();
        });
      });
      child.once("error", () => this.#fail("Native journal peer failed to start"));
      child.stdin.on("error", () => this.#fail("Native journal peer input failed"));
      child.stdout.on("error", () => this.#fail("Native journal peer output failed"));
      child.stderr.on("error", () => this.#fail("Native journal peer diagnostics failed"));
      child.stderr.on("data", (chunk: Buffer) => {
        this.#stderrBytes += chunk.length;
        if (this.#stderrBytes > 8192) this.#fail("Native journal diagnostic limit exceeded");
      });
      child.stdout.on("data", (chunk: Buffer) => this.#data(chunk));
    });
    try {
      if (this.#failure) throw this.#failure;
      if (lines.length !== 2) throw new Error("Invalid native journal greeting");
      const capability = NativeJournalCapabilitySchemaZ.parse(JSON.parse(lines[0]!));
      const identity = NativeJournalIdentitySchemaZ.parse(JSON.parse(lines[1]!));
      if (
        capability.readerTransport !== "sessionless-control-v1" ||
        !capability.enabled ||
        capability.serverEpoch !== this.#serverEpoch ||
        identity.serverEpoch !== this.#serverEpoch
      )
        throw new Error("Native journal peer incarnation mismatch");
      this.#connectionId = identity.connectionId;
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  async read(cursor: NativeJournalCursor, signal: AbortSignal): Promise<string> {
    const request = NativeJournalCursorSchemaZ.parse(cursor);
    if (request.serverEpoch !== this.#serverEpoch) throw new Error("Foreign native journal read");
    await this.start(signal);
    const lines = await this.#receive(1, 1, signal, () => {
      this.#process!.stdin.write(`read ${request.journalEpoch} ${request.sequence} 64 1\n`);
    });
    if (this.#failure) {
      await this.dispose();
      throw this.#failure;
    }
    if (lines.length !== 1) {
      await this.dispose();
      throw new Error("Invalid native journal response cardinality");
    }
    return lines[0]!;
  }

  async #receive(
    flags: number,
    maxLines: number,
    signal: AbortSignal,
    write: () => void,
  ): Promise<string[]> {
    signal.throwIfAborted();
    if (this.#failure) throw this.#failure;
    if (this.#pending) throw new Error("Native journal request already in flight");
    const abort = () => this.#fail("Native journal request cancelled");
    signal.addEventListener("abort", abort, { once: true });
    try {
      return await new Promise<string[]>((resolve, reject) => {
        this.#pending = { flags, maxLines, resolve, reject };
        try {
          write();
        } catch {
          this.#fail("Native journal request write failed");
        }
      });
    } catch (error) {
      await this.dispose();
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  #fail(message: string): void {
    this.#failure ??= new Error(message);
    this.#pending?.reject(this.#failure);
    this.#pending = null;
    this.#frame = null;
    this.#buffer = "";
    // An unsolicited failure between requests must still retire the peer.
    if (!this.#disposing) void this.dispose().catch(() => undefined);
  }

  #data(chunk: Buffer): void {
    if (this.#failure) return;
    try {
      if (chunk.length > MAX_REPLY_BYTES * 2) throw new Error("Oversized native control chunk");
      this.#buffer += chunk.toString("latin1");
      for (;;) {
        const end = this.#buffer.indexOf("\n");
        if (end < 0) {
          if (this.#buffer.length > MAX_REPLY_BYTES)
            throw new Error("Oversized native control line");
          return;
        }
        if (end > MAX_REPLY_BYTES) throw new Error("Oversized native control line");
        const line = this.#buffer.slice(0, end);
        this.#buffer = this.#buffer.slice(end + 1);
        const pending = this.#pending;
        if (!pending) throw new Error("Unsolicited native control data");
        const event = parseControlLine(line, this.#frame !== null);
        if (event.kind === "begin") {
          if (
            this.#frame ||
            !/^%begin [0-9]+ [0-9]+ [01]$/u.test(line) ||
            !Number.isSafeInteger(event.num) ||
            event.flags !== pending.flags
          )
            throw new Error("Invalid native control guard");
          this.#frame = { num: event.num, flags: event.flags, lines: [], bytes: 0 };
        } else if (event.kind === "reply-line") {
          const frame = this.#frame;
          if (!frame || frame.lines.length >= pending.maxLines)
            throw new Error("Invalid native control body");
          frame.bytes += line.length + 1;
          if (frame.bytes > MAX_REPLY_BYTES) throw new Error("Oversized native control reply");
          frame.lines.push(line);
        } else if (event.kind === "end") {
          const frame = this.#frame;
          if (
            !frame ||
            !/^%end [0-9]+ [0-9]+ [01]$/u.test(line) ||
            event.num !== frame.num ||
            event.flags !== frame.flags
          )
            throw new Error("Mismatched native control guard");
          this.#frame = null;
          this.#pending = null;
          pending.resolve(frame.lines);
        } else throw new Error("Unexpected native control frame");
      }
    } catch {
      this.#fail("Invalid bounded native journal protocol");
    }
  }

  dispose(): Promise<void> {
    if (this.#disposing) return this.#disposing;
    // Assign before failing pending work, since #fail also initiates cleanup.
    this.#disposing = Promise.resolve().then(async () => {
      this.#fail("Native journal peer disposed");
      const child = this.#process;
      if (!child) return;
      const wait = async (ms: number) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            this.#exited.then(() => true),
            new Promise<false>((resolve) => {
              timer = setTimeout(() => resolve(false), ms);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      try {
        child.stdin.write("\n");
      } catch {
        // A broken input pipe must not bypass process termination and reaping.
      }
      if (await wait(200)) return;
      child.kill("SIGTERM");
      if (await wait(500)) return;
      child.kill("SIGKILL");
      if (!(await wait(500))) throw new Error("Native journal peer could not be reaped");
    });
    return this.#disposing;
  }
}
