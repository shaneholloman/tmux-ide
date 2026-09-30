/** Opt-in data-only relocation proof. Never changes the supplied bundle or host catalog. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { PtyTmuxAttachmentLauncher } from "../packages/daemon/src/terminal/attachments/pty-tmux-attachment-launcher.ts";
import { planGroupedTmuxAttachment } from "../packages/daemon/src/terminal/attachments/grouped-tmux.ts";
import {
  TmuxAttachmentViewExecutor,
  TmuxAttachmentViewExecutorError,
  type TmuxAttachmentCommandRunner,
} from "../packages/daemon/src/terminal/attachments/tmux-view-executor.ts";
import { defaultNodePtyAdapter } from "../packages/daemon/src/terminal/NodePtyAdapter.ts";
import type {
  PtyProcess,
  PtySpawnInput,
  PtySpawnListeners,
} from "../packages/daemon/src/terminal/PtyAdapter.ts";
import {
  validateBundledTmux,
  withBundledTmuxResources,
} from "../packages/daemon/src/lib/bundled-tmux.ts";
import { fenceNativeTmuxCommand } from "../packages/daemon/src/lib/tmux-server-generation-runner.ts";
import { sparkExecutionIdentity, sparkProcessWitness } from "./lib/spark-process-witness.ts";
import { waitForTerminfoProcessExit } from "./lib/terminfo-exit-proof.ts";
import { createMacProcessIdentity } from "./lib/owned-ssh-fixture.mjs";
import { stageTerminfoCatalog } from "./lib/tmux-terminfo-bundle.mjs";
const pause = () => new Promise((resolve) => setTimeout(resolve, 20));
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    assert(Date.now() < deadline, "Terminfo proof deadline");
    await pause();
  }
}
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const [sourceArgument, catalogArgument, outputArgument] = process.argv.slice(2);
assert(
  sourceArgument && catalogArgument && outputArgument && process.argv.length === 5,
  "Expected bundle catalog output arguments",
);
const source = realpathSync(sourceArgument),
  catalog = realpathSync(catalogArgument),
  root = resolve(outputArgument);
assert(!existsSync(root), "Evidence root must be fresh");
mkdirSync(root, { mode: 0o700 });
const execution = process.platform === "linux" ? sparkExecutionIdentity() : null;
let disposeWitness: (() => Promise<unknown>) | undefined;
const witness =
  process.platform === "darwin"
    ? await createMacProcessIdentity({
        parent: root,
        onAllocated: (allocation: { disposeFiles(): Promise<unknown> }) => {
          disposeWitness = allocation.disposeFiles;
        },
      })
    : {
        identify: (pid: number) => {
          assert(execution);
          return sparkProcessWitness(pid, execution);
        },
      };
const sourceManifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8"));
const term = `xterm-tia-${randomUUID().replaceAll("-", "")}`;
const report: { term: string; sourceExecutableSha256: string; cases: unknown[]; ok: boolean } = {
  term,
  sourceExecutableSha256: sha(join(source, "tmux")),
  cases: [],
  ok: false,
};
try {
  for (const resources of [false, true]) {
    const directory = join(root, resources ? "positive" : "negative");
    mkdirSync(directory);
    const bundle = join(directory, "relocated");
    cpSync(source, bundle, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8"));
    assert.equal(manifest.terminfo, undefined, "Proof expects retained legacy bundle");
    if (resources) {
      const staged = stageTerminfoCatalog([catalog], join(bundle, "share/terminfo"));
      const xterm = staged.files.find((name: string) => name.endsWith("/xterm-256color"));
      assert(xterm);
      const bucket = xterm.split("/")[2];
      const alias = `share/terminfo/${bucket}/${term}`;
      cpSync(join(bundle, xterm), join(bundle, alias));
      for (const name of [...staged.files, alias]) manifest.files[name] = sha(join(bundle, name));
      manifest.terminfo = { directory: staged.directory, entries: staged.entries + 1 };
      writeFileSync(join(bundle, "manifest.json"), JSON.stringify(manifest));
    }
    for (const [name, expected] of Object.entries(sourceManifest.files)) {
      assert.equal(sha(join(source, name)), expected, "Retained source file changed");
      assert.equal(sha(join(bundle, name)), expected, "Copied native file changed");
    }
    const executable = validateBundledTmux(bundle);
    assert.equal(sha(executable), report.sourceExecutableSha256);
    const socket = join(directory, "s");
    assert(Buffer.byteLength(socket) < 103);
    const environment = withBundledTmuxResources(executable, {
      PATH: "/usr/bin:/bin",
      HOME: directory,
      TERM: term,
      LANG: "en_US.UTF-8",
      TMUX: "",
    });
    const raw = (args: readonly string[]) =>
      execFileSync(executable, ["-u", "-S", socket, "-f", "/dev/null", ...args], {
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        timeout: 5_000,
        killSignal: "SIGKILL",
        maxBuffer: 128 * 1024,
      });
    const children: { process: PtyProcess; closed: boolean }[] = [];
    const failures: unknown[] = [];
    let output = "",
      delivered = "",
      cleaned = false,
      paneGone = false,
      socketGone = false,
      killCommandFailed = false;
    let transport: PtyTmuxAttachmentLauncher | undefined;
    let retire: (() => Promise<void>) | undefined;
    try {
      raw(["new-session", "-d", "-s", "source", "-x", "100", "-y", "30", "exec /bin/cat"]);
      const [pid, startTime, sessionId, windowId, paneId, sessionName, panePid] = raw([
        "-N",
        "list-panes",
        "-a",
        "-F",
        "#{pid}\t#{start_time}\t#{session_id}\t#{window_id}\t#{pane_id}\t#{session_name}\t#{pane_pid}",
      ])
        .trim()
        .split("\t");
      assert(pid && startTime && sessionId && windowId && paneId);
      assert.equal(sessionName, "source", "Expected exactly one private source pane");
      assert(panePid && /^[1-9][0-9]*$/u.test(panePid), "Missing owned pane PID");
      const serverWitness = await witness.identify(Number(pid));
      assert(serverWitness);
      const paneWitness = await witness.identify(Number(panePid));
      assert(paneWitness);
      const socketStat = lstatSync(socket);
      assert(socketStat.isSocket());
      const run = (args: readonly string[]) => {
        const current = lstatSync(socket);
        assert(current.dev === socketStat.dev && current.ino === socketStat.ino);
        const command = fenceNativeTmuxCommand(["-N", ...args], { pid, startTime });
        return command.verify(raw(command.argv));
      };
      retire = async () => {
        assert.equal(await witness.identify(Number(pid)), serverWitness);
        try {
          run(["kill-server"]);
        } catch {
          killCommandFailed = true;
        }
        await waitForTerminfoProcessExit(witness.identify, Number(pid));
        await waitForTerminfoProcessExit(witness.identify, Number(panePid));
        paneGone = true;
        if (existsSync(socket)) {
          const stale = lstatSync(socket);
          assert(
            stale.isSocket() && stale.dev === socketStat.dev && stale.ino === socketStat.ino,
            "Socket replaced during retirement",
          );
          unlinkSync(socket);
        }
        socketGone = !existsSync(socket);
        cleaned = true;
      };
      writeFileSync(
        join(directory, "ownership.json"),
        JSON.stringify({
          pid,
          startTime,
          panePid,
          serverWitness,
          paneWitness,
          socketDev: socketStat.dev,
          socketIno: socketStat.ino,
        }),
      );
      const runner: TmuxAttachmentCommandRunner = {
        run(command) {
          try {
            return { status: "ok", stdout: run(command.argv) };
          } catch (error) {
            // Same result classification as tmux-view-executor-live.test.ts.
            const stderr = String(
              (error as { stderr?: string | Buffer }).stderr ?? "",
            ).toLowerCase();
            return stderr.includes("unknown variable:")
              ? { status: "variable-not-found" }
              : /(?:can't find|no such|not found|no server running)/u.test(stderr)
                ? { status: "not-found" }
                : { status: "failed" };
          }
        },
      };
      const plan = planGroupedTmuxAttachment({
        attachmentId: randomUUID(),
        generation: 0,
        target: { workspaceName: "terminfo", semanticPaneId: "pane.test" },
        viewerMode: "interactive",
        geometryOwnership: "passive",
        viewport: { cols: 100, rows: 30 },
        source: { sessionId, windowId, runtimePaneId: paneId, windowPaneCount: 1 },
      });
      const operation = {
        operation: "create" as const,
        exactViewSessionTarget: `=${plan.identity.viewSessionName}` as const,
        deadline: Date.now() + 5_000,
        source: { sessionId, windowId, runtimePaneId: paneId, windowPaneCount: 1 },
        plan,
      };
      function observeSpawn(input: PtySpawnInput, listeners?: PtySpawnListeners): PtyProcess {
        const child = { process: undefined as unknown as PtyProcess, closed: false };
        child.process = defaultNodePtyAdapter.spawnSync(input, {
          onData(data) {
            output = (output + data.toString()).slice(-65536);
            listeners?.onData?.(data);
          },
          onExit(event) {
            child.closed = true;
            listeners?.onExit?.(event);
          },
        });
        children.push(child);
        return child.process;
      }
      transport = new PtyTmuxAttachmentLauncher({
        socketSelector: { kind: "path", path: socket },
        trustedCwd: directory,
        tmuxExecutable: executable,
        environment,
        ptyAdapter: {
          id: defaultNodePtyAdapter.id,
          spawnSync: observeSpawn,
          async spawn(input, listeners) {
            return observeSpawn(input, listeners);
          },
        },
      });
      const executor = new TmuxAttachmentViewExecutor({ runner, clientTransport: transport });
      assert.equal(await executor.executeGuardedViewOperation(operation), "executed");
      const attach = () =>
        executor.executeGuardedViewOperation({ ...operation, operation: "attach" });
      if (!resources) {
        await assert.rejects(
          attach,
          (error: unknown) =>
            error instanceof TmuxAttachmentViewExecutorError &&
            error.code === "mutation-outcome-uncertain",
        );
        await until(() => children.length === 1 && children.every((child) => child.closed));
        assert(
          /(?:missing or unsuitable terminal|unknown terminal|can't find terminfo)/u.test(output),
          "Expected explicit missing terminal data failure",
        );
      } else {
        const result = await attach();
        assert(typeof result === "object" && result.status === "executed");
        assert.equal(children.length, 1, "Expected exactly one owned PTY child");
        const client = transport.claim(result.clientClaim);
        assert(client);
        client.onData((data) => {
          delivered = (delivered + data.toString()).slice(-65536);
        });
        const marker = "terminfo-relocated-io";
        assert.equal(client.boundedInput?.write(Buffer.from(marker + "\n")).status, "accepted");
        await until(
          () =>
            delivered.includes(marker) &&
            run(["capture-pane", "-p", "-t", paneId]).includes(marker),
        );
        client.resize(118, 32);
        await until(
          () =>
            run([
              "list-clients",
              "-F",
              "#{client_pid}\t#{client_width}\t#{client_height}",
            ]).trim() === `${client.pid}\t118\t32`,
        );
        client.dispose();
        await until(() => children.every((child) => child.closed));
      }
    } catch (error) {
      failures.push(error);
    } finally {
      const cleanupErrors: unknown[] = [];
      try {
        transport?.disposeAll();
        await until(() => children.every((child) => child.closed));
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        assert(
          retire,
          "Server identity unavailable; retaining uncertain allocation without signals",
        );
        await retire();
      } catch (error) {
        cleanupErrors.push(error);
      }
      writeFileSync(
        join(directory, "result.json"),
        JSON.stringify({
          resources,
          output,
          delivered,
          childCount: children.length,
          childClosed: children.every((child) => child.closed),
          serverGone: cleaned,
          paneGone,
          socketGone,
          childPids: children.map((child) => child.process.pid),
          killCommandFailed,
          cleanupFailures: cleanupErrors.length,
        }),
      );
      failures.push(...cleanupErrors);
    }
    if (failures.length) throw new AggregateError(failures, "Terminfo proof failed");
    report.cases.push({
      resources,
      childClosed: children.every((child) => child.closed),
      serverGone: cleaned,
    });
  }
  report.ok = true;
} finally {
  try {
    await disposeWitness?.();
  } finally {
    writeFileSync(join(root, "report.json"), JSON.stringify(report, null, 2));
  }
}
