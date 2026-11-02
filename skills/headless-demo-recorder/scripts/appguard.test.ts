import { expect, test } from "bun:test";
import { bundleRefusal, parseBundleId } from "./appguard.ts";

const sample = `[ NULL ]  ASN:0x0-0x2cc2cc0: (in front) \n    bundleID="com.apple.calculator"\n    bundle path=[ NULL ] \n`;

test("bundle ID is parsed from lsappinfo output, else undefined", () => {
  expect(parseBundleId(sample)).toBe("com.apple.calculator");
  expect(parseBundleId("")).toBeUndefined(); // unknown pid: empty output, exit 0
  expect(parseBundleId(`    bundleID=[ NULL ]\n`)).toBeUndefined();
  expect(parseBundleId(`    bundleID=""\n`)).toBeUndefined();
});

test("unknown bundle IDs fail closed", () => {
  expect(bundleRefusal(undefined)).toContain("fail closed");
  expect(bundleRefusal(undefined, ["com.apple.calculator"])).toContain("fail closed");
});

test("deny prefixes apply even when allowed", () => {
  for (const id of ["com.google.Chrome", "com.google.Chrome.app.abcdef", "com.apple.Safari", "com.microsoft.edgemac", "org.mozilla.firefox", "com.apple.Terminal", "com.apple.finder", "com.apple.systempreferences"]) {
    expect(bundleRefusal(id, [id])).toContain("deny list");
    expect(bundleRefusal(id)).toContain("deny list");
  }
});

test("allowApps restricts by exact bundle ID", () => {
  expect(bundleRefusal("com.apple.calculator", ["com.apple.calculator"])).toBeUndefined();
  expect(bundleRefusal("com.apple.Notes", ["com.apple.calculator"])).toContain("not in --allow-app");
  expect(bundleRefusal("com.apple.calculator.helper", ["com.apple.calculator"])).toContain("not in --allow-app");
  // No allowlist (manual CLI use): only the deny list applies.
  expect(bundleRefusal("com.apple.Notes")).toBeUndefined();
});
