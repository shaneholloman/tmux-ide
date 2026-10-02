import { expect, it } from "vitest";
import { requireSupportedTmuxVersion } from "./tmux-version.ts";

it.each(["3.7", "3.7c", "tmux 3.7c", "3.10", "4.0"])("accepts supported tmux %s", (version) => {
  expect(() => requireSupportedTmuxVersion(version)).not.toThrow();
});
it.each(["3.4", "3.6a", "2.9", "", "next", "garbage", "3.7oops"])(
  "rejects unsupported or unknown tmux %s",
  (version) => {
    expect(() => requireSupportedTmuxVersion(version)).toThrow("tmux 3.7 or newer is required");
  },
);
