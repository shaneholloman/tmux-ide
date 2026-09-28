/** Closed qualification adapter for the production SSH spawn seam; never executes itself. */
const discoveryPrefix = ["-T", "-o", "BatchMode=yes", "-o", "ForkAfterAuthentication=no", "--"];
const tunnelPrefix = [
  "-N",
  "-T",
  "-o",
  "BatchMode=yes",
  "-o",
  "ControlMaster=no",
  "-o",
  "ControlPath=none",
  "-o",
  "ForkAfterAuthentication=no",
  "-o",
  "ExitOnForwardFailure=yes",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=3",
  "-L",
];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const path = (value) => {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    !/^\/[A-Za-z0-9_./-]+$/u.test(value) ||
    value.split("/").includes("..")
  )
    throw new Error("Invalid private qualification path");
  return value;
};
export function sparkQualificationSshArgs(args, target) {
  if (!target || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(target.alias))
    throw new Error("Invalid qualification alias");
  const prefix = ["-F", path(target.config)];
  const discovery = [...discoveryPrefix, target.alias, "tmux-ide", "remote-daemon-info", "--json"];
  if (same(args, discovery)) {
    const command = [target.node, target.dispatcher, target.descriptor]
      .map(path)
      .map((value) => `'${value}'`)
      .join(" ");
    return [...prefix, ...discoveryPrefix, target.alias, command];
  }
  if (
    args.length !== tunnelPrefix.length + 3 ||
    !same(args.slice(0, tunnelPrefix.length), tunnelPrefix) ||
    args.at(-2) !== "--" ||
    args.at(-1) !== target.alias
  )
    throw new Error("Unexpected production SSH command");
  const match = /^127\.0\.0\.1:(\d+):127\.0\.0\.1:(\d+)$/u.exec(args[tunnelPrefix.length]);
  if (
    !match ||
    Number(match[1]) < 1 ||
    Number(match[1]) > 65535 ||
    Number(match[2]) !== target.port ||
    !Number.isInteger(target.port) ||
    target.port < 1 ||
    target.port > 65535
  )
    throw new Error("Unexpected qualification forwarding authority");
  return [...prefix, ...args];
}
