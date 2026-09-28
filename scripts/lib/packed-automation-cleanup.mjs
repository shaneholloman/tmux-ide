/** Retained handles only. A stuck stream must never postpone child termination. */
export async function settleAutomationResources(
  { children, subscriptions },
  { graceMs = 1000, killMs = 1000, streamMs = 1000 } = {},
) {
  const failures = [];
  const signal = (name) => {
    for (const child of children.keys()) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      try {
        child.kill(name);
      } catch (error) {
        failures.push(error);
      }
    }
  };
  signal("SIGTERM");
  for (const subscription of subscriptions) {
    try {
      subscription.close();
    } catch (error) {
      failures.push(error);
    }
  }
  async function bounded(promises, ms) {
    let timer;
    try {
      return await Promise.race([
        Promise.allSettled(promises),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  const streamSettlement = bounded(
    [...subscriptions].map((subscription) => subscription.done),
    streamMs,
  );
  let childResults = await bounded([...children.values()], graceMs);
  if (childResults === null) {
    signal("SIGKILL");
    childResults = await bounded([...children.values()], killMs);
  }
  const streamResults = await streamSettlement;
  if (childResults === null)
    failures.push(new Error("Packed automation children did not settle after SIGKILL"));
  if (streamResults === null)
    failures.push(new Error("Packed automation streams did not settle after close"));
  for (const result of [...(childResults ?? []), ...(streamResults ?? [])]) {
    if (result.status === "rejected") failures.push(result.reason);
  }
  if (failures.length) throw new AggregateError(failures, "Packed automation cleanup incomplete");
}
