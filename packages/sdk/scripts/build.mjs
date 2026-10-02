import ts from "typescript";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join } from "node:path";
import { build } from "esbuild";
import { rollup } from "rollup";
import { dts } from "rollup-plugin-dts";

const root = fileURLToPath(new URL("../", import.meta.url));
const entry = resolve(root, "src/index.ts");
mkdirSync(resolve(root, "dist"), { recursive: true });
const javascript = await build({
  entryPoints: [entry],
  outfile: resolve(root, "dist/index.js"),
  bundle: true,
  metafile: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  external: ["zod", "zod/*"],
});
// Keep the bundled runtime limited to our MIT workspace code. A new external
// implementation requires an explicit license review instead of silently shipping.
for (const input of Object.keys(javascript.metafile.inputs)) {
  const path = resolve(input);
  if (
    !["sdk", "contracts", "daemon-client"].some((name) =>
      path.startsWith(resolve(root, "..", name, "src") + "/"),
    )
  )
    throw new Error(`Unexpected bundled SDK dependency: ${input}`);
}
// Emit the workspace declaration graph once before bundling. Feeding every Zod
// source module independently to the bundler multiplies compiler work.
const stage = mkdtempSync(join(root, ".sdk-types-"));
try {
  const repo = resolve(root, "../..");
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    declaration: true,
    emitDeclarationOnly: true,
    allowImportingTsExtensions: true,
    strict: true,
    skipLibCheck: true,
    rootDir: repo,
    outDir: stage,
    baseUrl: repo,
    paths: {
      "@tmux-ide/contracts": ["packages/contracts/src/index.ts"],
      "@tmux-ide/daemon-client/owner-action-client": [
        "packages/daemon-client/src/owner-action-client.ts",
      ],
      "@tmux-ide/daemon-client/automation-client": [
        "packages/daemon-client/src/automation-client.ts",
      ],
    },
  };
  const program = ts.createProgram([entry], options);
  const emitted = program.emit(undefined, (file, content) => {
    mkdirSync(dirname(file), { recursive: true });
    // Declaration emit retains explicit .ts specifiers; the staged graph uses .d.ts.
    writeFileSync(file, content.replace(/(from\s+["']\.[^"']+)\.ts(["'])/gu, "$1.js$2"));
  });
  const diagnostics = [...ts.getPreEmitDiagnostics(program), ...emitted.diagnostics];
  if (diagnostics.length)
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (x) => x,
        getCurrentDirectory: () => root,
        getNewLine: () => "\n",
      }),
    );
  const types = await rollup({
    input: join(stage, "packages/sdk/src/index.d.ts"),
    external: (id) => id === "zod" || id.startsWith("zod/"),
    onwarn(warning, warn) {
      if (warning.code === "UNRESOLVED_IMPORT") throw new Error(warning.message);
      warn(warning);
    },
    plugins: [
      {
        name: "sdk-private-types",
        resolveId(id) {
          // TypeScript can refer inferred contract types back to this re-exporting entry.
          if (id === "packages/sdk/src/index.ts") return join(stage, "packages/sdk/src/index.d.ts");
          if (id === "@tmux-ide/contracts") return join(stage, "packages/contracts/src/index.d.ts");
          if (id === "@tmux-ide/daemon-client/owner-action-client")
            return join(stage, "packages/daemon-client/src/owner-action-client.d.ts");
          if (id === "@tmux-ide/daemon-client/automation-client")
            return join(stage, "packages/daemon-client/src/automation-client.d.ts");
        },
      },
      dts({ respectExternal: true }),
    ],
  });
  try {
    const { output } = await types.generate({ format: "es" });
    const declarations = output[0].code;
    if (/(?:from|import)\s*["']@tmux-ide\//u.test(declarations))
      throw new Error("SDK declarations retain private workspace references");
    writeFileSync(resolve(root, "dist/index.d.ts"), declarations);
  } finally {
    await types.close();
  }
} finally {
  rmSync(stage, { recursive: true, force: true });
}
console.log("[sdk] built host-neutral JavaScript and bundled declarations");
