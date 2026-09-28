import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "tmux-ide-sdk-consumer-"));
function run(command, args, cwd = directory) {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
try {
  run(process.execPath, [resolve(root, "scripts/build.mjs")], root);
  const packed = JSON.parse(
    run(
      "pnpm",
      ["--config.ignore-scripts=true", "pack", "--json", "--pack-destination", directory],
      root,
    ),
  );
  for (const file of packed.files) {
    if (!/^(package\.json|README\.md|LICENSE|dist\/index\.(js|d\.ts))$/u.test(file.path))
      throw new Error(`Unexpected SDK package file: ${file.path}`);
  }
  writeFileSync(join(directory, "package.json"), JSON.stringify({ private: true, type: "module" }));
  run("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    resolve(directory, packed.filename),
    "typescript@5.9.3",
  ]);
  const installed = join(directory, "node_modules/@tmux-ide/sdk");
  const metadata = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  for (const [name, version] of Object.entries(metadata.dependencies ?? {})) {
    if (name.startsWith("@tmux-ide/") || /^(workspace:|file:|link:)/u.test(version))
      throw new Error(`Private runtime dependency: ${name}`);
  }
  for (const file of ["dist/index.js", "dist/index.d.ts"]) {
    const source = readFileSync(join(installed, file), "utf8");
    if (/(?:from\s*|import\s*\()["'](?:@tmux-ide\/|node:|.*\/src\/)/u.test(source))
      throw new Error(`Private or Node import in ${file}`);
  }
  writeFileSync(
    join(directory, "consumer.mjs"),
    `
import { createTmuxIdeOwnerSdk, createTmuxIdeDaemonSdk, createTmuxIdeSdk } from '@tmux-ide/sdk';
if (typeof createTmuxIdeDaemonSdk !== 'function' || typeof createTmuxIdeSdk !== 'function') throw Error('Missing factory');
let calls = 0;
const sdk = createTmuxIdeOwnerSdk({ baseUrl: 'http://localhost:4000/', ownerToken: 'test', fetch: async () => { calls++; return Response.json({ok:false,error:{code:'forbidden',message:'refused'}}); } });
try { await sdk.sendPane({workspaceName:'project',semanticPaneId:'pane.test',text:'hello',submit:true}); throw Error('Unexpected success'); }
catch (error) { if (error.code !== 'forbidden' || calls !== 1) throw error; }
`,
  );
  run(process.execPath, ["consumer.mjs"]);
  writeFileSync(
    join(directory, "consumer.ts"),
    `
import { createTmuxIdeOwnerSdk, type WorkspacePaneSendResult } from '@tmux-ide/sdk';
const sdk = createTmuxIdeOwnerSdk({baseUrl:'http://localhost:4000',ownerToken:'test'});
const result: Promise<WorkspacePaneSendResult> = sdk.sendPane({workspaceName:'project',semanticPaneId:'pane.test',text:'hello',submit:true});
void result;
`,
  );
  run(process.execPath, [
    "node_modules/typescript/bin/tsc",
    "--noEmit",
    "--strict",
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    "--target",
    "ES2022",
    "consumer.ts",
  ]);
  const browser = await build({
    entryPoints: [join(directory, "consumer.mjs")],
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    write: false,
    metafile: true,
  });
  if (Object.values(browser.metafile.outputs).some((output) => output.imports.length))
    throw new Error("Browser SDK bundle retained external imports");
  console.log(
    `[sdk:pack] ${packed.files.length} files; isolated Node runtime, strict TypeScript and browser bundle passed`,
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
