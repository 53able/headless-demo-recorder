import { expect, test } from "bun:test";
import { atLeast } from "./doctor.ts";

test("atLeast compares the first x.y.z in tool output", () => {
  expect(atLeast("agent-browser 0.41.1", "0.41.0")).toBe(true);
  expect(atLeast("agent-browser 0.40.0", "0.41.0")).toBe(false);
  expect(atLeast("1.0.2", "1.0.2")).toBe(true);
  expect(atLeast("0.100.0", "0.41.0")).toBe(true); // numeric, not lexical
  expect(atLeast("2.0.0", "10.0.0")).toBe(false);
  expect(atLeast("no version here", "0.0.1")).toBe(false);
});
