import assert from "node:assert/strict";

/** Qualification exit proof only: a transient missing /proc file is never proof of death. */
export async function waitForTerminfoProcessExit(
  identify: (pid: number) => string | null | Promise<string | null>,
  pid: number,
  clock: {
    now(): number;
    wait(milliseconds: number): Promise<void>;
  } = {
    now: Date.now,
    wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  },
): Promise<void> {
  assert(Number.isSafeInteger(pid) && pid > 0);
  const deadline = clock.now() + 5_000;
  for (;;) {
    assert(clock.now() < deadline, "Terminfo process exit unproven at deadline");
    try {
      const identity = await identify(pid);
      assert(clock.now() < deadline, "Terminfo process exit unproven at deadline");
      if (identity === null) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const remaining = deadline - clock.now();
    assert(remaining > 0, "Terminfo process exit unproven at deadline");
    await clock.wait(Math.min(20, remaining));
  }
}
