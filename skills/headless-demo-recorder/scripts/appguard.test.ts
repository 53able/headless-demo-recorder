import { expect, test } from "bun:test";
import { asToolError } from "./errors.ts";
import { ancestorsOf, bundleRefusal, foregroundUnder, keyWindowCandidates, launcherRunsInside, optInRefusal, parseBundleId, parsePs, sessionsUnder, sharedSessionUnder, soleWindowRefusal } from "./appguard.ts";

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

test("press needs the recorded window to be the app's only window", () => {
  expect(soleWindowRefusal("TextEdit", ["w-1"], "w-1")).toBeUndefined();
  expect(soleWindowRefusal("TextEdit", ["w-1", "w-2"], "w-2")).toContain("2 windows");
  expect(soleWindowRefusal("TextEdit", ["w-1", "w-2"], "w-1")).toContain("2 windows"); // even when it is listed first
  expect(soleWindowRefusal("TextEdit", ["w-1"], "w-2")).toContain("is gone");
  expect(soleWindowRefusal("TextEdit", [], "w-1")).toContain("is gone");
});

test("an inaccessible overlay inside the recorded window is not a keyboard candidate", () => {
  const main = { id: "w-1373", pid: 62930, visible: true, accessible: true, bounds: { x: 1062, y: 956, width: 230, height: 408 } };
  const overlay = { id: "w-1449", pid: 62930, visible: true, accessible: false, bounds: { x: 1078, y: 972, width: 66, height: 20 } }; // measured on Calculator
  const ids = (ws: typeof main[]) => keyWindowCandidates(ws, "w-1373", 62930);
  expect(ids([main, overlay])).toEqual(["w-1373"]);
  expect(ids([main, { ...overlay, accessible: true }])).toEqual(["w-1373", "w-1449"]);
  expect(ids([main, { ...overlay, visible: false }])).toEqual(["w-1373", "w-1449"]); // hidden: may be on another Space
  expect(ids([main, { ...overlay, bounds: { x: 0, y: 0, width: 66, height: 20 } }])).toEqual(["w-1373", "w-1449"]); // outside
  expect(ids([main, { ...overlay, bounds: { x: 1062, y: 956, width: 200, height: 300 } }])).toEqual(["w-1373", "w-1449"]); // inside but large
  expect(ids([main, { ...overlay, pid: 1 }])).toEqual(["w-1373"]); // another instance
  expect(ids([main, { ...overlay, accessible: true, pid: undefined as unknown as number }])).toEqual(["w-1373", "w-1449"]); // unknown pid counts
  // The recorded window's current bounds decide: once it has moved, the overlay is outside it and counts.
  expect(ids([{ ...main, bounds: { x: 0, y: 0, width: 230, height: 408 } }, overlay])).toEqual(["w-1373", "w-1449"]);
  expect(ids([overlay])).toEqual(["w-1449"]); // recorded window gone: nothing excluded
});

test("guard refusals map to their own error codes", () => {
  expect(asToolError(new Error("WINDOW_NOT_SOLE: TextEdit has 2 windows"), "capture")).toMatchObject({ code: "WINDOW_NOT_SOLE", retry: "no" });
  expect(asToolError(new Error("APP_NOT_ALLOWED: x"), "capture")).toMatchObject({ code: "APP_NOT_ALLOWED", retry: "no" });
  // A refusal that quotes an agent-desktop error keeps its own code.
  expect(asToolError(new Error("WINDOW_NOT_SOLE: cannot list the windows of X (fail closed): AMBIGUOUS_TARGET"), "capture")).toMatchObject({ code: "WINDOW_NOT_SOLE" });
  expect(asToolError(new Error("agent-desktop find: AMBIGUOUS_TARGET two windows"), "capture")).toMatchObject({ code: "TARGET_NOT_FOUND" });
});

// A Terminal.app (300) with two shells; the agent (600) runs in the second, under tmux.
const PS = `    1     0 Ss   /sbin/launchd
  300     1 S    /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal
  310   300 Ss   login
  311   310 S+   -zsh
  320   300 Ss   login
  321   320 S    -zsh
  322   321 S+   tmux
  400     1 Ss   tmux
  401   400 Ss+  -zsh
  600   401 S+   /opt/homebrew/bin/bun
  700     1 S    /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper
`;

test("ps rows are parsed, names with spaces included", () => {
  const rows = parsePs(PS);
  expect(rows).toHaveLength(11);
  expect(rows.at(-1)).toEqual({ pid: 700, ppid: 1, stat: "S", comm: "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper" });
  expect(parsePs("garbage\n\n")).toEqual([]);
});

test("ancestorsOf walks to launchd, and an unfinished walk is unknown", () => {
  const rows = parsePs(PS);
  expect(ancestorsOf(rows, 311)).toEqual([311, 310, 300, 1]);
  expect(ancestorsOf(rows, 600)).toEqual([600, 401, 400, 1]); // under a daemonized tmux server: Terminal is not in it
  expect(ancestorsOf(rows, 999)).toBeUndefined(); // not in the table
  expect(ancestorsOf([{ pid: 10, ppid: 11, stat: "S", comm: "a" }, { pid: 11, ppid: 10, stat: "S", comm: "b" }], 10)).toBeUndefined(); // cycle
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

test("each tab or window of a terminal app is one direct child; only one may run", () => {
  const rows = parsePs(PS);
  expect(sessionsUnder(rows, 300)).toBe(2); // two login sessions: two tabs (or windows) behind one listed window
  const ok = { windowIds: ["w-1"], recordedId: "w-1", cliRunsInside: false };
  expect(optInRefusal("com.apple.Terminal", { ...ok, sessions: 2 })).toContain("2 terminal sessions");
  expect(optInRefusal("com.apple.Terminal", { ...ok, sessions: 0 })).toContain("0 terminal sessions");
  expect(optInRefusal("com.apple.Terminal", { ...ok, sessions: 1 })).toBeUndefined();
  // Measured: a Terminal.app with one listed window ran a second tab with another Claude Code session.
  const measured = parsePs(`14211 1 S /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal
57807 14211 Ss login
57808 57807 S+ -zsh
87813 14211 Ss login
87814 87813 S -zsh
88512 87814 S+ claude
`);
  expect(optInRefusal("com.apple.Terminal", { ...ok, sharedSession: sharedSessionUnder(measured, 14211), sessions: sessionsUnder(measured, 14211) })).toContain("2 terminal sessions");
});

test("before recording, the terminal session must wait at its shell prompt", () => {
  // Measured on Terminal.app: the idle tab's shell is "S+"; in the other tab the shell is "S" and claude is "S+".
  const tab = (shellStat: string, extra = "") => parsePs(`14211 1 S /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal
87813 14211 Ss login
87814 87813 ${shellStat} -zsh
${extra}`);
  expect(foregroundUnder(tab("S+"), 14211)).toBeUndefined();
  expect(foregroundUnder(tab("S", "88512 87814 S+ claude\n88780 88512 S+ node\n"), 14211)).toBe("claude");
  expect(foregroundUnder(tab("S", "90000 87814 S+ /usr/bin/vim\n"), 14211)).toBe("vim");
  // A background helper of the shell (gitstatusd of powerlevel10k, say) is not in the foreground.
  expect(foregroundUnder(tab("S+", "90001 87814 S /opt/gitstatusd\n"), 14211)).toBeUndefined();
  // A shell started without login is a direct child of the app.
  expect(foregroundUnder(parsePs("14211 1 S Terminal\n500 14211 Ss+ -zsh\n"), 14211)).toBeUndefined();
  // A program that replaced the shell, or that the session started instead of one, is refused even
  // without "+" and even directly under login or the app.
  expect(foregroundUnder(parsePs("14211 1 S Terminal\n87813 14211 Ss login\n87814 87813 S+ claude\n"), 14211)).toBe("claude"); // exec claude
  expect(foregroundUnder(parsePs("14211 1 S Terminal\n500 14211 Ss+ /usr/local/bin/claude\n"), 14211)).toBe("claude"); // New Command
  expect(foregroundUnder(parsePs("14211 1 S Terminal\n87813 14211 Ss login\n87814 87813 S /usr/local/bin/claude\n"), 14211)).toBe("claude");
  expect(foregroundUnder(parsePs("14211 1 S Terminal\n87813 14211 Ss login\n87814 87813 Ss+ /opt/homebrew/bin/fish\n"), 14211)).toBeUndefined();
  const ok = { windowIds: ["w-1"], recordedId: "w-1", cliRunsInside: false, sessions: 1 };
  expect(optInRefusal("com.apple.Terminal", { ...ok, foreground: "claude" })).toContain("running claude in the foreground");
  expect(optInRefusal("com.apple.Terminal", ok)).toBeUndefined();
});

test("a shared-session client under the app is found by base name", () => {
  const rows = parsePs(PS);
  expect(sharedSessionUnder(rows, 300)).toBe("tmux"); // the tmux client in the second shell
  expect(sharedSessionUnder(rows.filter((r) => r.pid !== 322), 300)).toBeUndefined();
  expect(sharedSessionUnder(parsePs(PS + "  330   311 S+   /usr/bin/ssh\n").filter((r) => r.pid !== 322), 300)).toBe("ssh");
  expect(sharedSessionUnder(rows, 700)).toBeUndefined();
});
