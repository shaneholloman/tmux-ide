import { z } from "zod";
import { shellEscape } from "./shell.ts";

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
): readonly string[] {
  z.uuid().parse(operationId);
  if (serverEpoch !== undefined) z.uuid().parse(serverEpoch);
  if (!commands.length || commands.length > MAX_COMMANDS)
    throw new Error("Invalid native operation command count");
  let bytes = 0;
  const body = commands
    .map((argv) => {
      if (!argv.length || argv.length > 256 || !/^[a-z][a-z0-9-]*$/u.test(argv[0]!))
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
    "-O",
    operationId,
    body,
  ];
}
