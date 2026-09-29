import assert from "node:assert/strict";
import { test } from "node:test";
import { sparkQualificationSshArgs } from "./spark-qualification-ssh.mjs";
const target = {
  alias: "spark-private",
  config: "/tmp/local/config",
  node: "/tmp/remote/node",
  dispatcher: "/tmp/remote/handshake.mjs",
  descriptor: "/tmp/remote/lease.json",
  port: 34567,
};
const discovery = [
  "-T",
  "-o",
  "BatchMode=yes",
  "-o",
  "ForkAfterAuthentication=no",
  "--",
  target.alias,
  "tmux-ide",
  "remote-daemon-info",
  "--json",
];
const tunnel = [
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
  "127.0.0.1:23456:127.0.0.1:34567",
  "--",
  target.alias,
];
test("replaces only exact discovery with fixed private dispatcher", () => {
  const translated = sparkQualificationSshArgs(discovery, target);
  assert.deepEqual(translated.slice(0, 2), ["-F", target.config]);
  assert.equal(
    translated.at(-1),
    "/usr/bin/env -i HOME='/tmp/remote' PATH=/usr/bin:/bin '/tmp/remote/node' '/tmp/remote/handshake.mjs' '/tmp/remote/lease.json'",
  );
  assert.deepEqual(sparkQualificationSshArgs(tunnel, target), ["-F", target.config, ...tunnel]);
});
test("rejects arbitrary commands, extra options, changed aliases and forwarding targets", () => {
  for (const args of [
    [...discovery, ";", "touch", "/tmp/unwanted"],
    discovery.map((x) => (x === target.alias ? "other" : x)),
    [...tunnel, "-R", "123:host:456"],
    tunnel.map((x) => (x.includes("23456:") ? "127.0.0.1:23456:127.0.0.1:34568" : x)),
  ])
    assert.throws(() => sparkQualificationSshArgs(args, target));
  assert.throws(() =>
    sparkQualificationSshArgs(discovery, { ...target, dispatcher: "/tmp/$(bad)" }),
  );
});
