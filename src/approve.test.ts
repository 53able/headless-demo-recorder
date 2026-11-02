import { expect, test } from "bun:test";
import { approvalSummary, hashMismatch, runPaths, sha256Hex } from "./approve.ts";
import type { Scenario } from "./types.ts";

const scenario: Scenario = {
  name: "calc", source: { type: "desktop", app: "Calculator" }, output: { path: "out/calc.mp4" },
  steps: [{ action: "click", target: { role: "button", name: "1" }, caption: "1 を押す" }],
};
const bytes = JSON.stringify(scenario);
const hash = sha256Hex(bytes);

test("approval is bound to the exact scenario bytes", () => {
  expect(hashMismatch(bytes, hash)).toBeUndefined();
  expect(hashMismatch(Buffer.from(bytes), hash)).toBeUndefined();
  expect(hashMismatch(bytes + " ", hash)).toContain("does not match");
  expect(hashMismatch(bytes.replace("1 を押す", "2 を押す"), hash)).toContain("does not match");
});

test("run paths reject traversal and malformed hashes", () => {
  expect(runPaths("/r", "run-1", hash).approval).toBe(`/r/run-1/approvals/${hash}.json`);
  expect(runPaths("/r", "run-1", hash).scenario).toBe(`/r/run-1/scenarios/${hash}.json`);
  expect(() => runPaths("/r", "../x", hash)).toThrow();
  expect(() => runPaths("/r", "a/b", hash)).toThrow();
  expect(() => runPaths("/r", "run-1", "../../etc")).toThrow();
  expect(() => runPaths("/r", "run-1", hash.toUpperCase())).toThrow();
});

test("summary shows apps, every step with its caption, and the hash", () => {
  const text = approvalSummary(scenario, ["com.apple.calculator"], "com.apple.calculator", hash);
  expect(text).toContain("com.apple.calculator");
  expect(text).toContain("1 を押す");
  expect(text).toContain(hash);
});
