import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exists, run } from "./exec.ts";

const cli = join(import.meta.dir, "cli.ts");

/** A fake agent-browser: one page with one button (@e1, "#go"); "#nope" does not exist.
 * `record stop` copies a real clip to the path given to `record start`, so ffmpeg/ffprobe run for real. */
const fakeBrowser = (log: string, clip: string, state: string) => `#!${process.execPath}
import { appendFileSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const has = (...w) => w.every((x) => args.includes(x));
const ok = (data) => { console.log(JSON.stringify({ success: true, data })); process.exit(0); };
if (has("record", "start")) writeFileSync(${JSON.stringify(state)}, args[args.indexOf("start") + 1]);
if (has("record", "stop")) copyFileSync(${JSON.stringify(clip)}, readFileSync(${JSON.stringify(state)}, "utf8"));
if (args.includes("#nope")) { console.error("Element not found: #nope"); process.exit(1); }
if (has("--json", "snapshot")) ok({ origin: "http://127.0.0.1/", refs: { e1: { role: "button", name: "Go" } }, snapshot: '- button "Go" [ref=e1]' });
if (has("--json", "get", "box")) ok({ x: 100, y: 200, width: 120, height: 40 });
process.exit(0);
`;

test("session: observe, act one step at a time, refuse and survive bad steps, stop into a renderable project", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hdr-session-"));
  try {
    const clip = join(dir, "clip.mp4");
    const gen = await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10", "-t", "3", "-c:v", "mpeg4", clip]);
    expect(gen.code).toBe(0);
    const log = join(dir, "calls.jsonl");
    const browser = join(dir, "agent-browser");
    await writeFile(browser, fakeBrowser(log, clip, join(dir, "record-path")));
    await chmod(browser, 0o755);
    const scenarioPath = join(dir, "s.json");
    await writeFile(scenarioPath, JSON.stringify({ name: "s", source: { type: "browser", url: "http://127.0.0.1:9/" }, output: { path: join(dir, "out", "s.mp4") } }));
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` } as Record<string, string>;
    const hdr = async (...args: string[]) => JSON.parse((await run(process.execPath, [cli, ...args], { env, timeoutMs: 60_000 })).stdout) as Record<string, any>;
    const proj = join(dir, "out", "s.project");

    expect(await hdr("session", "start", scenarioPath, "--group", "g1", "--allow-origin", "http://127.0.0.1:9")).toMatchObject({ ok: true, status: "recording", group: "g1" });
    // One recorder per project: a second session, or a scenario capture, is refused while it runs.
    expect(await hdr("session", "start", scenarioPath, "--force")).toMatchObject({ ok: false, code: "SESSION_ACTIVE" });
    expect(await hdr("capture", scenarioPath, "--force")).toMatchObject({ ok: false, code: "SESSION_ACTIVE" });

    const seen = await hdr("session", "observe", proj);
    expect(seen.ok).toBe(true);
    expect(seen.snapshot.refs.e1.name).toBe("Go");
    // A ref from observe is a valid target inside the session.
    const acted = await hdr("session", "act", proj, JSON.stringify({ action: "click", target: "@e1", caption: "go" }));
    expect(acted).toMatchObject({ ok: true, stage: "act", event: { kind: "click", label: "@e1" } });
    expect(acted.event.point.cx).toBeCloseTo(160 / 1280, 5);
    // The click may have relabelled the element; its ref is not trusted again until the next observe.
    expect(await hdr("session", "act", proj, JSON.stringify({ action: "click", target: "@e1" }))).toMatchObject({ ok: false, code: "INVALID_STEP" });
    // Guards still apply: nothing runs, the recording continues.
    expect(await hdr("session", "act", proj, JSON.stringify({ action: "click", target: "text=Delete account" }))).toMatchObject({ ok: false, code: "INVALID_STEP", retry: "after-fix" });
    expect(await hdr("session", "act", proj, JSON.stringify({ action: "open", url: "https://example.com/" }))).toMatchObject({ ok: false, code: "INVALID_STEP" });
    expect(await hdr("session", "act", proj, "{not json")).toMatchObject({ ok: false, code: "BAD_JSON" });
    // A failed step is dropped from the log; the agent is told to look again, not to re-record.
    expect(await hdr("session", "act", proj, JSON.stringify({ action: "click", target: "#nope" }))).toMatchObject({ ok: false, code: "TARGET_NOT_FOUND", retry: "after-fix" });
    expect(await hdr("session", "status", proj)).toMatchObject({ ok: true, status: "recording", events: 1 });

    const stopped = await hdr("session", "stop", proj);
    expect(stopped).toMatchObject({ ok: true, stage: "capture", projectDir: proj, events: 1 });
    const capture = JSON.parse(await readFile(join(proj, "capture.json"), "utf8"));
    expect(capture.runId).toBe("session-group:g1");
    expect(typeof capture.t0EpochMs).toBe("number");
    const events = JSON.parse(await readFile(join(proj, "events.json"), "utf8"));
    expect(events.map((e: { label: string }) => e.label)).toEqual(["@e1"]);
    expect(await exists(join(proj, "capture.mp4"))).toBe(true);
    expect(await hdr("session", "status", proj)).toMatchObject({ status: "stopped" });
    expect(await hdr("session", "act", proj, JSON.stringify({ action: "wait", ms: 1 }))).toMatchObject({ ok: false, code: "SESSION_NOT_RUNNING" });
    // The browser was released.
    const calls = (await readFile(log, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as string[]);
    expect(calls.some((a) => a.includes("close"))).toBe(true);
    // A saved session is an ordinary project.
    expect(await hdr("plan", proj)).toMatchObject({ ok: true, stage: "compile" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);

test("session start: refuses file sources and bad flags before launching anything", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hdr-session-args-"));
  try {
    const file = join(dir, "f.json");
    await writeFile(file, JSON.stringify({ name: "f", source: { type: "file", path: "x.mp4" }, output: { path: join(dir, "f.mp4") } }));
    const browser = join(dir, "b.json");
    await writeFile(browser, JSON.stringify({ name: "b", source: { type: "browser", url: "https://example.com/" }, output: { path: join(dir, "b.mp4") } }));
    const hdr = async (...args: string[]) => JSON.parse((await run(process.execPath, [cli, ...args])).stdout) as Record<string, unknown>;
    expect(await hdr("session", "start", file)).toMatchObject({ ok: false, code: "BAD_ARGS" });
    expect(await hdr("session", "start", browser, "--idle-timeout", "1")).toMatchObject({ ok: false, code: "BAD_ARGS" });
    expect(await hdr("session", "start", browser, "--group", "a b")).toMatchObject({ ok: false, code: "BAD_ARGS" });
    expect(await hdr("session", "observe", join(dir, "b.project"))).toMatchObject({ ok: false, code: "NO_SESSION" });
    expect(await exists(join(dir, "b.project", "session"))).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- the server itself, in process, with a fake driver ----

import { mkdir } from "node:fs/promises";
import type { Driver } from "./capture/driver.ts";
import { sleep } from "./exec.ts";
import { readState, refIssues, request, serve, type SessionConfig } from "./session.ts";
import type { ActionEvent, Step } from "./types.ts";

function fakeDriver() {
  const events: ActionEvent[] = [];
  const f = { live: true, observed: false, closed: 0 };
  const labels: Record<string, string> = { "@e1": "button Go", "@e2": "button Delete account" };
  const d: Driver = {
    act: async (step: Step) => {
      if (step.action === "wait") await sleep(step.ms, false);
      f.observed = false; // like the real drivers: names from an observe are trusted only until the next input
      const ev: ActionEvent = { tMs: 0, kind: step.action === "wait" ? "wait" : "click", label: "target" in step ? String(step.target) : undefined };
      events.push(ev);
      return ev;
    },
    observe: async () => ((f.observed = true), { tMs: 0, snapshot: { refs: { e1: { role: "button", name: "Go" } } } }),
    refLabel: (r) => (f.observed ? labels[r] : undefined),
    alive: () => f.live,
    elapsedMs: () => 0,
    eventCount: () => events.length,
    close: async () => void f.closed++,
    finish: async () => ({ videoPath: "x.mp4", width: 10, height: 10, durationMs: 1, events, realCursor: false }),
  };
  return { d, f, events };
}

async function startServe(idleTimeoutMs: number, source: SessionConfig["scenario"]["source"] = { type: "browser", url: "https://example.com/" }) {
  const projDir = await mkdtemp(join(tmpdir(), "hdr-serve-"));
  await mkdir(join(projDir, "session"));
  const config: SessionConfig = {
    scenarioPath: "s.json", scenario: { name: "s", source, output: { path: "s.mp4" } }, cwd: projDir,
    allowOrigins: [], allowApps: [], keepWork: false, idleTimeoutMs,
  };
  await writeFile(join(projDir, "session", "config.json"), JSON.stringify(config));
  const fake = fakeDriver();
  const saved: unknown[] = [];
  const served = serve(projDir, { start: async () => fake.d, validate: () => [], save: async (c) => (saved.push(c), { ok: true, saved: true }) });
  for (let i = 0; i < 50 && (await readState(projDir))?.status !== "recording"; i++) await sleep(50, false);
  return { projDir, served, saved, ...fake };
}

test("serve: refs must come from the latest observe and are checked by name; status answers during a long step; a dead recorder stops the session", async () => {
  const s = await startServe(1000);
  try {
    const act = (step: unknown) => request(s.projDir, { op: "act", step }, 10_000);
    expect(await act({ action: "click", target: "@e1" })).toMatchObject({ ok: false, code: "INVALID_STEP" }); // not observed yet
    expect(await request(s.projDir, { op: "observe" }, 10_000)).toMatchObject({ ok: true, stage: "observe" });
    const destructive = await act({ action: "click", target: "@e2" });
    expect(destructive).toMatchObject({ ok: false, code: "INVALID_STEP" });
    expect(String(destructive.message)).toContain("Delete account");
    expect(await act({ action: "click", target: "@e9" })).toMatchObject({ ok: false, code: "INVALID_STEP" });
    // Every spelling agent-browser accepts for a ref is looked up by name, not only "@eN".
    for (const t of ["e2", "ref=e2", " e2", "@e2 ", "\t@e2"]) {
      const r = await act({ action: "click", target: t });
      expect(r).toMatchObject({ ok: false, code: "INVALID_STEP" });
      expect(String(r.message)).toContain("Delete account");
    }
    expect(await act({ action: "click", target: "@e2", allowDestructive: true })).toMatchObject({ ok: true });
    // After an input the names are stale: the same ref needs a fresh observe.
    expect(await act({ action: "click", target: "@e1" })).toMatchObject({ ok: false, code: "INVALID_STEP" });
    await request(s.projDir, { op: "observe" }, 10_000);
    // What is checked is what runs: a padded ref executes as the canonical "@eN".
    expect(await act({ action: "click", target: " ref=e1 " })).toMatchObject({ ok: true, event: { label: "@e1" } });
    await request(s.projDir, { op: "observe" }, 10_000);
    expect(await act({ action: "click", target: "@e1" })).toMatchObject({ ok: true });

    // A step longer than the idle timeout: status still answers, and idle does not stop the session under it.
    const long = act({ action: "wait", ms: 1600 });
    await sleep(300, false);
    expect(await request(s.projDir, { op: "status" }, 2_000)).toMatchObject({ ok: true, status: "recording", busy: true });
    expect(await long).toMatchObject({ ok: true });
    expect((await readState(s.projDir))?.status).toBe("recording");

    s.f.live = false;
    expect(await act({ action: "click", target: "@e1" })).toMatchObject({ ok: false, code: "RECORDER_DIED", retry: "no" });
    expect(await s.served).toMatchObject({ ok: true, saved: true });
    expect(await readState(s.projDir)).toMatchObject({ status: "stopped", reason: "the recorder exited" });
    expect(s.saved).toHaveLength(1);
    expect(s.events.map((e) => e.label)).toEqual(["@e2", "@e1", "@e1", undefined]);
  } finally {
    await rm(s.projDir, { recursive: true, force: true });
  }
}, 30_000);

test("serve: an idle session stops and saves on its own", async () => {
  const s = await startServe(1000);
  try {
    expect(await s.served).toMatchObject({ ok: true, saved: true });
    expect((await readState(s.projDir))?.reason).toBe("idle for 1000ms");
  } finally {
    await rm(s.projDir, { recursive: true, force: true });
  }
}, 15_000);

test("refIssues: every desktop string is a ref and must come from the recorded window's latest observe", () => {
  const config = { scenario: { name: "d", source: { type: "desktop", app: "Calculator" }, output: { path: "d.mp4" } } } as SessionConfig;
  const driver = { refLabel: (r: string) => ({ "@s1:e1": "button 7", "@s1:e2": "button 削除" })[r] };
  expect(refIssues({ action: "click", target: "@s1:e1" }, config, driver)).toEqual([]);
  expect(refIssues({ action: "click", target: "@other:e1" }, config, driver)).toHaveLength(1); // e.g. another app's snapshot
  expect(refIssues({ action: "click", target: "@s1:e2" }, config, driver)).toHaveLength(1);
  expect(refIssues({ action: "click", target: { role: "button", name: "7" } }, config, driver)).toEqual([]); // find queries are checked by validateStep
  // A browser selector is not a ref.
  const browser = { scenario: { name: "b", source: { type: "browser", url: "https://example.com/" }, output: { path: "b.mp4" } } } as SessionConfig;
  expect(refIssues({ action: "click", target: "#go" }, browser, driver)).toEqual([]);
});

test("session: a click that opens a new tab is refused, the tab is closed and the recorded tab is active again", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hdr-newtab-"));
  try {
    const clip = join(dir, "clip.mp4");
    expect((await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10", "-t", "2", "-c:v", "mpeg4", clip])).code).toBe(0);
    const log = join(dir, "calls.jsonl");
    const tab = join(dir, "active-tab");
    // Like agent-browser: "#nt" opens t2 and makes it the active tab; "tab <id>" switches back.
    await writeFile(join(dir, "agent-browser"), `#!${process.execPath}
import { appendFileSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const has = (...w) => w.every((x) => args.includes(x));
const active = () => (existsSync(${JSON.stringify(tab)}) ? readFileSync(${JSON.stringify(tab)}, "utf8") : "t1");
if (has("record", "start")) writeFileSync(${JSON.stringify(join(dir, "rec"))}, args[args.indexOf("start") + 1]);
if (has("record", "stop")) copyFileSync(${JSON.stringify(clip)}, readFileSync(${JSON.stringify(join(dir, "rec"))}, "utf8"));
if (has("click", "#nt")) writeFileSync(${JSON.stringify(tab)}, "t2");
const i = args.indexOf("tab");
if (i >= 0 && args[i + 1] && !["list", "close"].includes(args[i + 1])) writeFileSync(${JSON.stringify(tab)}, args[i + 1]);
if (has("--json", "tab", "list")) {
  const tabs = [{ tabId: "t1", url: "http://127.0.0.1:9/", active: active() === "t1" }];
  if (active() === "t2") tabs.push({ tabId: "t2", url: "http://127.0.0.1:9/second.html", active: true });
  console.log(JSON.stringify({ success: true, data: { tabs } }));
} else if (has("--json", "get", "box")) console.log(JSON.stringify({ success: true, data: { x: 10, y: 10, width: 50, height: 20 } }));
process.exit(0);
`);
    await chmod(join(dir, "agent-browser"), 0o755);
    const scenarioPath = join(dir, "s.json");
    await writeFile(scenarioPath, JSON.stringify({ name: "t", source: { type: "browser", url: "http://127.0.0.1:9/" }, output: { path: join(dir, "out", "t.mp4") } }));
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` } as Record<string, string>;
    const hdr = async (...args: string[]) => JSON.parse((await run(process.execPath, [cli, ...args], { env, timeoutMs: 60_000 })).stdout) as Record<string, any>;
    const proj = join(dir, "out", "t.project");

    expect(await hdr("session", "start", scenarioPath)).toMatchObject({ ok: true });
    const r = await hdr("session", "act", proj, JSON.stringify({ action: "click", target: "#nt" }));
    expect(r).toMatchObject({ ok: false, retry: "after-fix" });
    expect(String(r.message)).toContain("NEW_TAB");
    expect(String(r.message)).toContain("second.html");
    expect(await hdr("session", "act", proj, JSON.stringify({ action: "click", target: "#go" }))).toMatchObject({ ok: true });
    expect(await hdr("session", "stop", proj)).toMatchObject({ ok: true, events: 1 });
    const calls = (await readFile(log, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as string[]);
    expect(calls.some((a) => a.includes("tab") && a.includes("close") && a.includes("t2"))).toBe(true);
    expect(calls.some((a) => a[a.length - 2] === "tab" && a[a.length - 1] === "t1")).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);
