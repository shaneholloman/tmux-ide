#!/usr/bin/env node
/** Remote qualification-only read: no process startup, no arbitrary command input. */
import { openSync, fstatSync, readSync, closeSync, constants } from "node:fs";
import { validateSparkQualificationDescriptor } from "./lib/spark-qualification-descriptor.mjs";
import { register } from "tsx/esm/api";
// Qualification source imports include TypeScript parameter properties; plain
// Node type stripping cannot load them. Register the pinned workspace loader.
register();
const { resolveDevelopmentInstance } =
  await import("../packages/daemon/src/lib/development-instance.ts");
const { developmentSshHandshake } = await import("../packages/daemon/src/lib/development-ssh.ts");
if (process.argv.length !== 3) throw new Error("One private lease descriptor is required");
const fd = openSync(process.argv[2], constants.O_RDONLY | constants.O_NOFOLLOW);
let descriptor;
try {
  const stat = fstatSync(fd);
  if (
    !stat.isFile() ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o077) !== 0 ||
    stat.size > 16384
  )
    throw new Error("Private lease descriptor refused");
  const bytes = Buffer.alloc(16385);
  const length = readSync(fd, bytes, 0, bytes.length, 0);
  if (length !== stat.size || length > 16384) throw new Error("Private lease descriptor changed");
  descriptor = JSON.parse(bytes.subarray(0, length).toString("utf8"));
} finally {
  closeSync(fd);
}
validateSparkQualificationDescriptor(descriptor);
const instance = resolveDevelopmentInstance(descriptor.instance);
// The shared helper independently revalidates the expected lease and invokes
// the verified build's CLI using its isolated owner environment.
process.stdout.write(await developmentSshHandshake(instance, descriptor.expected));
