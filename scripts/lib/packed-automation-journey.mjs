import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  capturePackedTmuxWitness,
  packedTmuxWitnessDifferences,
} from "./packed-install-cleanup.mjs";

const quote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** Reuses the caller's already owned private server; never starts or retires a daemon. */
export async function runPackedAutomationJourney({
  root,
  directory,
  installedCli,
  socket,
  environment,
  daemonInfoPath,
  run,
  runAsync,
  cancellation,
  evidence,
}) {
  evidence.phase = "preparing-sdk";
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const consumer = join(directory, "consumer");
  mkdirSync(consumer, { mode: 0o700 });
  const sdkRoot = join(root, "packages/sdk");
  await runAsync(process.execPath, [join(sdkRoot, "scripts/build.mjs")], {
    cwd: sdkRoot,
    timeout: 180000,
  });
  const packed = JSON.parse(
    (
      await runAsync(
        "pnpm",
        ["--config.ignore-scripts=true", "pack", "--json", "--pack-destination", directory],
        { cwd: sdkRoot, timeout: 60000 },
      )
    ).stdout,
  );
  const tarball = resolve(directory, packed.filename);
  evidence.sdkTarballPath = tarball;
  evidence.sdkTarballSha256 = sha256(tarball);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  await runAsync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], {
    cwd: consumer,
    timeout: 180000,
  });
  copyFileSync(
    join(root, "scripts/lib/packed-automation-consumer.mjs"),
    join(consumer, "consumer.mjs"),
  );
  copyFileSync(
    join(root, "scripts/lib/packed-automation-cleanup.mjs"),
    join(consumer, "packed-automation-cleanup.mjs"),
  );
  Object.assign(evidence, {
    phase: "sdk-installed",
    installedSdkSha256: sha256(join(consumer, "node_modules/@tmux-ide/sdk/dist/index.js")),
    cleanupSourceSha256: sha256(join(consumer, "packed-automation-cleanup.mjs")),
    consumerSourceSha256: sha256(join(consumer, "consumer.mjs")),
    sdkVersion: JSON.parse(
      readFileSync(join(consumer, "node_modules/@tmux-ide/sdk/package.json"), "utf8"),
    ).version,
  });
  const env = { ...environment };
  for (const key of Object.keys(env))
    if (key === "NODE_OPTIONS" || key.startsWith("TMUX_IDE_PACK_")) delete env[key];
  // runAsync merges environment overrides: explicitly empty the preload, never inherit it.
  env.NODE_OPTIONS = "";
  const tmux = (args) => run("tmux", ["-S", socket, ...args], { env }).stdout.trim();
  const pid = Number(tmux(["display-message", "-p", "#{pid}"]));
  const witness = capturePackedTmuxWitness(socket, pid);
  const session = `pack-auto-${randomUUID().slice(0, 8)}`;
  const targetFile = join(directory, "target-input"),
    sourceFile = join(directory, "source-input");
  writeFileSync(targetFile, "", { mode: 0o600 });
  writeFileSync(sourceFile, "", { mode: 0o600 });
  const program = join(directory, "terminal.mjs");
  writeFileSync(
    program,
    `import { appendFileSync } from 'node:fs';\nimport { createInterface } from 'node:readline';\nprocess.stdout.write('PACK_READ_PRIVATE\\n');\ncreateInterface({input:process.stdin}).on('line',line=>{appendFileSync(process.argv[2],line+'\\n');process.stdout.write(line+'\\n');});\n`,
  );
  const command = (file) =>
    `stty -echo; exec ${quote(process.execPath)} ${quote(program)} ${quote(file)}`;
  const configPath = join(directory, "private-consumer.json");
  let created = false;
  try {
    const sourcePane = tmux([
      "new-session",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-s",
      session,
      command(sourceFile),
    ]);
    created = true;
    const targetPane = tmux([
      "split-window",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-t",
      sourcePane,
      command(targetFile),
    ]);
    tmux(["set-option", "-p", "-t", sourcePane, "@tmux_ide_pane_id", "pane.pack-source"]);
    tmux(["set-option", "-p", "-t", targetPane, "@tmux_ide_pane_id", "pane.pack-target"]);
    const info = JSON.parse(readFileSync(daemonInfoPath, "utf8"));
    writeFileSync(
      configPath,
      JSON.stringify({
        consumer,
        cli: installedCli,
        socket,
        session,
        sourcePane,
        sourceFile,
        targetFile,
        ownerToken: info.authToken,
        baseUrl: `http://127.0.0.1:${info.port}`,
      }),
      { mode: 0o600 },
    );
    evidence.canonicalInstanceId = info.instanceId;
    evidence.phase = "consumer-running";
    const result = await runAsync(process.execPath, [join(consumer, "consumer.mjs"), configPath], {
      cwd: consumer,
      stdio: "inherit",
      env: { ...env, TMUX: `${socket},${pid},0`, TMUX_PANE: sourcePane },
      timeout: 120000,
      maxBuffer: 1024 * 1024,
    });
    const observations = JSON.parse(result.stdout);
    assert.equal(readFileSync(targetFile, "utf8"), "PACK_PRIVATE_cli\nPACK_PRIVATE_sdk\n");
    assert.equal(readFileSync(sourceFile, "utf8"), "");
    Object.assign(evidence, observations, { phase: "consumer-passed" });
    return evidence;
  } finally {
    rmSync(configPath, { force: true });
    if (created)
      await cancellation.cleanup(async () => {
        const current = capturePackedTmuxWitness(
          socket,
          Number(tmux(["display-message", "-p", "#{pid}"])),
        );
        assert.deepEqual(
          packedTmuxWitnessDifferences(witness, current),
          [],
          "Private server changed; refusing session teardown",
        );
        tmux(["kill-session", "-t", `=${session}`]);
      });
  }
}
