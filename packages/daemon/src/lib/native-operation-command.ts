import { z } from "zod";
import { NativeJournalUint64SchemaZ } from "@tmux-ide/contracts";
import { shellEscape } from "./shell.ts";

// A normal 256-byte hex input batch needs 260 argv entries.
const MAX_COMMAND_ARGUMENTS = 512;
const MAX_COMMANDS = 64;
const MAX_BODY_BYTES = 262_144;

/**
 * Keep command boundaries separate from literal arguments. In particular, a
 * payload containing only `;` must never become a second tmux command.
 * The native -I path parses this string with command aliases disabled.
 */
export function nativeOperationWrapperArgs(
  operationId: string,
  commands: readonly (readonly string[])[],
  serverEpoch?: string,
  target?: Readonly<{ paneId: string; paneBirthId: string }>,
): readonly string[] {
  z.uuid().parse(operationId);
  if (serverEpoch !== undefined) z.uuid().parse(serverEpoch);
  if (target) {
    if (
      !serverEpoch ||
      !/^%(0|[1-9][0-9]*)$/u.test(target.paneId) ||
      BigInt(target.paneId.slice(1)) > 4294967295n
    )
      throw new Error("Invalid guarded native pane identity");
    NativeJournalUint64SchemaZ.refine((value) => value !== "0").parse(target.paneBirthId);
  }
  if (!commands.length || commands.length > MAX_COMMANDS)
    throw new Error("Invalid native operation command count");
  let bytes = 0;
  const body = commands
    .map((argv) => {
      if (
        !argv.length ||
        argv.length > MAX_COMMAND_ARGUMENTS ||
        !/^[a-z][a-z0-9-]*$/u.test(argv[0]!)
      )
        throw new Error("Invalid native operation command");
      const words = argv.map((arg) => {
        if (typeof arg !== "string" || arg.includes("\0"))
          throw new Error("Invalid native operation argument");
        bytes += Buffer.byteLength(arg, "utf8");
        if (bytes > MAX_BODY_BYTES) throw new Error("Native operation command limit exceeded");
        return shellEscape(arg);
      });
      return words.join(" ");
    })
    .join(" ; ");
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES)
    throw new Error("Native operation command limit exceeded");
  return [
    "tmux-ide-run",
    "-I",
    ...(serverEpoch ? ["-E", serverEpoch] : []),
    ...(target ? ["-t", target.paneId, "-B", target.paneBirthId] : []),
    "-O",
    operationId,
    body,
  ];
}
