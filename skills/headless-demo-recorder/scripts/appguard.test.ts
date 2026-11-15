import { expect, test } from "bun:test";
import { ancestorsOf, bundleRefusal, launcherRunsInside, optInRefusal, parseBundleId, parsePs, sharedSessionUnder } from "./appguard.ts";

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
  for (const id of ["com.google.Chrome", "com.google.Chrome.app.abcdef", "com.apple.Safari", "com.microsoft.edgemac", "org.mozilla.firefox", "com.apple.finder", "com.apple.systempreferences"]) {
    expect(bundleRefusal(id, [id])).toContain("deny list");
    expect(bundleRefusal(id)).toContain("deny list");
  }
});

test("Terminal.app is refused unless named in allowApps", () => {
  expect(bundleRefusal("com.apple.Terminal")).toContain("explicit --allow-app");
  expect(bundleRefusal("com.apple.Terminal", ["com.apple.calculator"])).toContain("explicit --allow-app");
  expect(bundleRefusal("com.apple.Terminal", ["com.apple.Terminal"])).toBeUndefined();
  expect(bundleRefusal("com.apple.Terminal", ["com.apple.Terminal", "com.apple.calculator"])).toBeUndefined();
});

test("bundle IDs under an opt-in prefix need the flag too", () => {
  expect(bundleRefusal("com.apple.Terminal.helper")).toContain("explicit --allow-app");
  expect(bundleRefusal("com.apple.Terminal.helper", ["com.apple.Terminal"])).toContain("explicit --allow-app");
  expect(bundleRefusal("com.apple.Terminal.helper", ["com.apple.Terminal.helper"])).toBeUndefined();
  expect(bundleRefusal("com.apple.Terminal", [])).toContain("explicit --allow-app");
});

test("an opt-in app takes input only through its sole, recorded window, from outside it", () => {
  const T = "com.apple.Terminal";
  const ok = { windowIds: ["w-1"], recordedId: "w-1", cliRunsInside: false };
  expect(optInRefusal(T, ok)).toBeUndefined();
  expect(optInRefusal(T, { ...ok, windowIds: ["w-1", "w-2"] })).toContain("2 windows");
  expect(optInRefusal(T, { ...ok, windowIds: [] })).toContain("is gone");
  expect(optInRefusal(T, { ...ok, windowIds: ["w-2"] })).toContain("is gone");
  expect(optInRefusal(T, { ...ok, cliRunsInside: true })).toContain("runs inside");
  expect(optInRefusal(T, { ...ok, cliRunsInside: undefined })).toContain("fail closed");
  expect(optInRefusal(T, { ...ok, sharedSession: "tmux" })).toContain("tmux runs inside");
});

// A Terminal.app (300) with two shells; the agent (600) runs in the second, under tmux.
const PS = `    1     0 /sbin/launchd
  300     1 /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal
  310   300 login
  311   310 -zsh
  320   300 login
  321   320 -zsh
  322   321 tmux
  400     1 tmux
  401   400 -zsh
  600   401 /opt/homebrew/bin/bun
  700     1 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper
`;

test("ps rows are parsed, names with spaces included", () => {
  const rows = parsePs(PS);
  expect(rows).toHaveLength(11);
  expect(rows.at(-1)).toEqual({ pid: 700, ppid: 1, comm: "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper" });
  expect(parsePs("garbage\n\n")).toEqual([]);
});

test("ancestorsOf walks to launchd, and an unfinished walk is unknown", () => {
  const rows = parsePs(PS);
  expect(ancestorsOf(rows, 311)).toEqual([311, 310, 300, 1]);
  expect(ancestorsOf(rows, 600)).toEqual([600, 401, 400, 1]); // under a daemonized tmux server: Terminal is not in it
  expect(ancestorsOf(rows, 999)).toBeUndefined(); // not in the table
  expect(ancestorsOf([{ pid: 10, ppid: 11, comm: "a" }, { pid: 11, ppid: 10, comm: "b" }], 10)).toBeUndefined(); // cycle
});

test("the launcher's ancestors come from the caller when given, unknown when null", () => {
  const rows = parsePs(PS);
  expect(launcherRunsInside(undefined, rows, 311, 300)).toBe(true); // own ancestry
  expect(launcherRunsInside(undefined, rows, 600, 300)).toBe(false);
  expect(launcherRunsInside(undefined, rows, 999, 300)).toBeUndefined();
  expect(launcherRunsInside([311, 310, 300, 1], rows, 600, 300)).toBe(true); // a session server: the launcher's chain wins
  expect(launcherRunsInside([600, 401, 400, 1], rows, 311, 300)).toBe(false);
  expect(launcherRunsInside(null, rows, 600, 300)).toBeUndefined(); // session start could not read it
});

test("a shared-session client under the app is found by base name", () => {
  const rows = parsePs(PS);
  expect(sharedSessionUnder(rows, 300)).toBe("tmux"); // the tmux client in the second shell
  expect(sharedSessionUnder(rows.filter((r) => r.pid !== 322), 300)).toBeUndefined();
  expect(sharedSessionUnder(parsePs(PS + "  330   311 /usr/bin/ssh\n").filter((r) => r.pid !== 322), 300)).toBe("ssh");
  expect(sharedSessionUnder(rows, 700)).toBeUndefined();
});
