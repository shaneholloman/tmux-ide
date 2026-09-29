import { isAbsolute, resolve } from "node:path";
const refuse = () => {
  throw new Error("Private lease descriptor shape refused");
};
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) =>
  record(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const path = (value) =>
  typeof value === "string" &&
  value.length <= 4096 &&
  !/[\0\r\n]/u.test(value) &&
  isAbsolute(value) &&
  resolve(value) === value;
export function validateSparkQualificationDescriptor(value) {
  if (!exact(value, ["version", "instance", "expected"]) || value.version !== 1) refuse();
  const { instance, expected } = value;
  if (
    !exact(instance, ["worktree", "name", "store"]) ||
    !path(instance.worktree) ||
    !path(instance.store) ||
    typeof instance.name !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,47}$/u.test(instance.name)
  )
    refuse();
  if (!record(expected)) refuse();
  // The shared developmentSshHandshake compares every expected field against
  // the actual verified owner lease. Do not duplicate its evolving schema here.
  return value;
}
