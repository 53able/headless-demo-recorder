import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControllerError, RunController, type RunControllerOptions } from "./controller.ts";
import type { Adapter, CliCall, CliCommand, CliJson, CliResult, ExecBin, ExecResult, Tile } from "./types.ts";

const ORIGIN = "http://127.0.0.1:4173";
const APP = "com.apple.calculator";
const SECRET = "DUMMY-s3cret-7f3a9c";

type Handler = (call: CliCall) => CliJson | Promise<CliJson>;

/** Stub of the CLI: writes the files the real commands would, records every call. */
class StubAdapter implements Adapter {
  calls: CliCall[] = [];
  execs: { bin: ExecBin; args: string[] }[] = [];
  active = 0;
  maxActive = 0;
  killed = 0;
  captureScenarios: unknown[] = [];
  handlers: Partial<Record<CliCommand, Handler>> = {};
  private hang?: () => void;
  hangNext = false;

  async cli(call: CliCall): Promise<CliResult> {
    this.calls.push(call);
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (this.hangNext) {
        this.hangNext = false;
        await new Promise<void>((r) => (this.hang = r));
        return { exitCode: 143, timedOut: false, json: { ok: false, code: "INTERRUPTED", retry: "no" } };
      }
      await new Promise((r) => setTimeout(r, 2));
      const json = await (this.handlers[call.cmd] ?? this.defaults[call.cmd])(call);
      return { exitCode: json.ok ? 0 : 1, timedOut: false, json };
    } finally {
      this.active--;
    }
  }

  async exec(bin: ExecBin, args: string[]): Promise<ExecResult> {
    this.execs.push({ bin, args });
    if (bin === "pgrep") return { code: 1, stdout: "", stderr: "", timedOut: false };
    if (bin === "agent-desktop" && args[0] === "launch") return { code: 0, stdout: JSON.stringify({ ok: true, data: { app: "Calculator" } }), stderr: "", timedOut: false };
    return { code: 0, stdout: `- button "Submit" [ref=e1]\n- textbox "Password" [ref=e2]`, stderr: "", timedOut: false };
  }

  async killInFlight(): Promise<void> {
    this.killed++;
    this.hang?.();
    this.hang = undefined;
  }

  defaults: Record<CliCommand, Handler> = {
    doctor: () => ({ ok: true, checks: [] }),
    check: () => ({ ok: true, issues: [] }),
    capture: async (call) => {
      const sc = JSON.parse(await readFile(call.args[0]!, "utf8")) as { name: string; output: { path: string } };
      this.captureScenarios.push(sc);
      const projectDir = sc.output.path.replace(/\.mp4$/, ".project");
      await mkdir(projectDir, { recursive: true });
      await writeFile(join(projectDir, "events.json"), JSON.stringify([0, 1, 2].map((i) => ({ tMs: 1000 * (i + 1), kind: "click", caption: `c${i}` }))));
      return { ok: true, stage: "capture", projectDir, events: 3, durationMs: 4000 };
    },
    render: async (call) => {
      const out = call.args[call.args.indexOf("--out") + 1]!;
      await writeFile(out, "mp4");
      return { ok: true, stage: "render", outputPath: out, durationMs: 4000, timelineEdited: false };
    },
    inspect: async (call) => {
      const sheet = join(call.args[0]!, "inspect-sheet.png");
      await writeFile(sheet, "png");
      return { ok: true, stage: "inspect", sheet, frames: [0, 1, 2].map((index) => ({ index, tMs: 1000, kind: "click" })), timelineEdited: false };
    },
  };
}

let runsDir: string;
let clock: number;
beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), "ctl-test-"));
  clock = 1_000_000;
});
afterEach(async () => {
  await rm(runsDir, { recursive: true, force: true });
});

function make(adapter: Adapter, over: Partial<RunControllerOptions> = {}) {
  return new RunController({ runsDir, runId: "run1", request: "demo", allowOrigins: [ORIGIN], adapter, now: () => clock, ...over });
}

const browserScenario = (extra: Record<string, unknown> = {}) => ({
  name: "demo",
  source: { type: "browser", url: `${ORIGIN}/` },
  steps: [{ action: "click", target: "text=Submit", caption: "Submit" }],
  output: { path: "ignored.mp4" },
  ...extra,
});
const desktopScenario = () => ({
  name: "calc",
  source: { type: "desktop", app: APP },
  steps: [{ action: "click", target: { role: "button", name: "7" } }],
  output: { path: "x.mp4" },
});
const tiles = (n = 3, over: Partial<Tile> = {}): Tile[] =>
  Array.from({ length: n }, (_, index) => ({ index, acted_element_visible: true, cursor_on_target: true, caption_readable: true, privacy_issue: false, ...over }));

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "resolved";
  } catch (e) {
    expect(e).toBeInstanceOf(ControllerError);
    return (e as ControllerError).code;
  }
}

async function toInspected(c: RunController) {
  const { versionId } = await c.check(browserScenario());
  await c.record(versionId);
  const { renderId } = await c.render(versionId, {});
  const { inspectId } = await c.inspect(renderId);
  return { versionId, renderId, inspectId };
}

async function allFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await allFiles(p)));
    else out.push(p);
  }
  return out;
}

describe("happy path", () => {
  test("browser run finishes with exit 0, verdict and summary; controller flags on every CLI call", async () => {
    const a = new StubAdapter();
    const c = make(a);
    const { renderId, inspectId } = await toInspected(c);
    const r = await c.finish({ renderId, inspectId, tiles: tiles() });
    expect(r.accepted).toBe(true);
    expect(c.getState()).toBe("finished");
    expect(c.exitCode()).toBe(0);
    for (const call of a.calls) {
      expect(call.flags.allowOrigins).toEqual([ORIGIN]);
      expect(call.flags.sessionName).toMatch(/^ca-run1/);
    }
    const verdict = JSON.parse(await readFile(join(runsDir, "run1", "verdict.json"), "utf8"));
    expect(verdict.accepted).toBe(true);
    const summary = JSON.parse(await readFile(join(runsDir, "run1", "summary.json"), "utf8"));
    expect(summary).toMatchObject({ exitCode: 0, reason: "accepted", toolCalls: 5, captures: 1, rerenders: 0 });
    const ledger = JSON.parse(await readFile(join(runsDir, "run1", "ledger.json"), "utf8"));
    expect(ledger.sessions).toEqual(["ca-run1-1"]); // the capture session, closed at the end
    expect(a.execs.some((e) => e.bin === "agent-browser" && e.args.join(" ") === "--session ca-run1-1 close")).toBe(true);
    const lines = (await readFile(join(runsDir, "run1", "tools.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(5);
    expect(existsSync(join(runsDir, "run1", "out", "render-1.mp4"))).toBe(true);
  });

  test("explore records snapshots; check warns on targets not seen", async () => {
    const a = new StubAdapter();
    const c = make(a);
    await c.exploreBrowser(`${ORIGIN}/`);
    const explore = JSON.parse(await readFile(join(runsDir, "run1", "explore.json"), "utf8"));
    expect(explore.entries).toHaveLength(1);
    const r = await c.check(browserScenario({ steps: [{ action: "click", target: "text=Submit" }, { action: "click", target: "#nope" }] }));
    expect(r.warnings.some((w) => w.includes("#nope"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("Submit"))).toBe(false);
    expect(await codeOf(c.exploreBrowser("http://evil.example/"))).toBe("ORIGIN_NOT_ALLOWED");
  });
});

describe("allowlists come from the launch config only", () => {
  test("scenario-supplied allowlists are dropped and never reach the CLI", async () => {
    const a = new StubAdapter();
    const c = make(a);
    const r = await c.check(browserScenario({ allowOrigins: ["http://evil.example"], source: { type: "browser", url: `${ORIGIN}/`, allowedDomains: "evil.example" } }));
    expect(r.warnings.filter((w) => w.includes("ignored"))).toHaveLength(2);
    const stored = await readFile(join(runsDir, "run1", "scenarios", `${r.versionId}.json`), "utf8");
    expect(stored).not.toContain("evil.example");
    expect(a.calls.at(-1)!.flags.allowOrigins).toEqual([ORIGIN]);
  });

  test("a URL outside the controller's allowlist is refused even if the scenario allows it", async () => {
    const a = new StubAdapter();
    const c = make(a);
    const code = await codeOf(c.check(browserScenario({ allowOrigins: ["http://evil.example"], source: { type: "browser", url: "http://evil.example/" } })));
    expect(code).toBe("INVALID_SCENARIO");
    expect(await codeOf(c.check(browserScenario({ source: { type: "browser", url: "http://127.0.0.1:9999/" } })))).toBe("INVALID_SCENARIO");
    expect(a.calls).toHaveLength(0); // refused before the CLI ran
  });

  test("limits and unknown keys", async () => {
    const c = make(new StubAdapter());
    const many = Array.from({ length: 31 }, () => ({ action: "mark", caption: "x" }));
    expect(await codeOf(c.check(browserScenario({ steps: many })))).toBe("INVALID_SCENARIO");
    expect(await codeOf(c.check(browserScenario({ steps: [{ action: "wait", ms: 10_001 }] })))).toBe("INVALID_SCENARIO");
    expect(await codeOf(c.check(browserScenario({ steps: [{ action: "mark", caption: "x".repeat(41) }] })))).toBe("INVALID_SCENARIO");
    expect(await codeOf(c.check(browserScenario({ edit: { style: { padding: 0 } } })))).toBe("INVALID_SCENARIO");
    expect(await codeOf(c.check(browserScenario({ edit: { trim: [] } })))).toBe("INVALID_SCENARIO");
    expect(await codeOf(c.check(browserScenario({ allowDestructive: true })))).toBe("INVALID_SCENARIO");
    expect(await codeOf(c.check(browserScenario({ extra: 1 })))).toBe("INVALID_SCENARIO");
  });
});

describe("budgets", () => {
  test("captures: failed attempts count; the third attempt ends the run with exit 4", async () => {
    const a = new StubAdapter();
    a.handlers.capture = () => ({ ok: false, code: "BOX", retry: "after-fix", message: "flaky" });
    const c = make(a);
    const { versionId } = await c.check(browserScenario());
    expect(await codeOf(c.record(versionId))).toBe("BOX");
    expect(await codeOf(c.record(versionId))).toBe("BOX");
    expect(await codeOf(c.record(versionId))).toBe("BUDGET_EXHAUSTED");
    expect(c.getState()).toBe("exhausted");
    expect(c.exitCode()).toBe(4);
    expect(a.calls.filter((x) => x.cmd === "capture")).toHaveLength(2);
    expect(c.budget().captures).toEqual({ used: 2, max: 2 });
  });

  test("rerenders: 1 render + 3 rerenders, the next render is exhausted", async () => {
    const c = make(new StubAdapter());
    const { versionId } = await c.check(browserScenario());
    await c.record(versionId);
    for (let i = 0; i < 4; i++) await c.render(versionId, {});
    expect(c.budget().rerenders.used).toBe(3);
    expect(await codeOf(c.render(versionId, {}))).toBe("BUDGET_EXHAUSTED");
    expect(c.exitCode()).toBe(4);
    expect(c.getReason()).toBe("rerenders");
  });

  test("a rejected verdict with no rerenders left is exhausted (quality)", async () => {
    const c = make(new StubAdapter(), { budgets: { rerenders: 0 } });
    const { renderId, inspectId } = await toInspected(c);
    const r = await c.finish({ renderId, inspectId, tiles: tiles(3, { cursor_on_target: false }) });
    expect(r.accepted).toBe(false);
    expect(c.getState()).toBe("exhausted");
    expect(c.getReason()).toBe("quality");
  });

  test("invalid edits are refused without consuming the rerender budget", async () => {
    const c = make(new StubAdapter());
    const { versionId } = await c.check(browserScenario());
    await c.record(versionId);
    await c.render(versionId, {});
    expect(await codeOf(c.render(versionId, { timeShift: [{ eventIndex: 0, deltaMs: 2000 }] }))).toBe("INVALID_EDITS");
    expect(await codeOf(c.render(versionId, { captions: [{ eventIndex: 9, text: "x" }] }))).toBe("INVALID_EDITS");
    expect(await codeOf(c.render(versionId, { style: {} } as never))).toBe("INVALID_EDITS");
    expect(c.budget().rerenders.used).toBe(0);
    await c.render(versionId, { captions: [{ eventIndex: 1, text: "new" }], zoom: { depth: 3 }, captionFontSize: 48 });
    const events = JSON.parse(await readFile(join(runsDir, "run1", "out", "take-1", "demo.project", "events.json"), "utf8"));
    expect(events[1].caption).toBe("new");
    const edit = JSON.parse(await readFile(join(runsDir, "run1", "out", "edit-2.json"), "utf8"));
    expect(edit).toMatchObject({ zoom: { depth: 3 }, captionFontSize: 48 });
  });

  test("tool calls: every call counts, including refused ones", async () => {
    const c = make(new StubAdapter(), { budgets: { toolCalls: 3 } });
    expect(await codeOf(c.record("nope"))).toBe("BAD_STATE");
    expect(await codeOf(c.inspect("render-9"))).toBe("BAD_STATE");
    await c.doctor();
    expect(await codeOf(c.doctor())).toBe("BUDGET_EXHAUSTED");
    expect(c.getReason()).toBe("tool_calls");
    expect(c.exitCode()).toBe(4);
  });

  test("deadline via the injected clock", async () => {
    const c = make(new StubAdapter());
    await c.doctor();
    clock += 900_000;
    expect(await codeOf(c.doctor())).toBe("DEADLINE");
    expect(c.getReason()).toBe("deadline");
    expect(c.exitCode()).toBe(4);
  });

  test("a CLI call is refused when less than the 30s cleanup margin remains; the timeout passed is remaining − 30s", async () => {
    const a = new StubAdapter();
    const c = make(a);
    clock += 800_000;
    await c.doctor();
    expect(a.calls[0]!.timeoutMs).toBe(70_000);
    clock += 75_000;
    expect(await codeOf(c.doctor())).toBe("DEADLINE");
  });

  test("budget.json is persisted after each call", async () => {
    const c = make(new StubAdapter());
    await c.doctor();
    const b = JSON.parse(await readFile(join(runsDir, "run1", "budget.json"), "utf8"));
    expect(b.toolCalls).toEqual({ used: 1, max: 40 });
  });
});

describe("serialization and terminal states", () => {
  test("concurrent record + finish run one at a time, with state re-checked before each", async () => {
    const a = new StubAdapter();
    const c = make(a);
    const { versionId } = await c.check(browserScenario());
    const [rec, fin] = await Promise.allSettled([c.record(versionId), c.finish({ renderId: "render-1", inspectId: "inspect-1", tiles: tiles() })]);
    expect(rec.status).toBe("fulfilled");
    expect(fin.status).toBe("rejected");
    expect(((fin as PromiseRejectedResult).reason as ControllerError).code).toBe("BAD_STATE");
    await Promise.all([c.render(versionId, {}), c.render(versionId, {}), c.render(versionId, {})]);
    expect(a.maxActive).toBe(1);
    expect(c.budget().toolCalls.used).toBe(6);
  });

  test("everything is refused after finish", async () => {
    const c = make(new StubAdapter());
    const { versionId, renderId, inspectId } = await toInspected(c);
    await c.finish({ renderId, inspectId, tiles: tiles() });
    for (const p of [c.doctor(), c.record(versionId), c.render(versionId, {}), c.finish({ renderId, inspectId, tiles: tiles() })]) expect(await codeOf(p)).toBe("RUN_ENDED");
    expect(c.exitCode()).toBe(0);
  });

  test("retry:no → handoff (exit 3), sessions closed, side effects refused afterwards", async () => {
    const a = new StubAdapter();
    a.handlers.capture = () => ({ ok: false, code: "TARGET_NOT_FOUND", retry: "no", message: "Element not found" });
    const c = make(a);
    const { versionId } = await c.check(browserScenario());
    expect(await codeOf(c.record(versionId))).toBe("HANDOFF");
    expect(c.getState()).toBe("handoff");
    expect(c.exitCode()).toBe(3);
    expect(a.execs.some((e) => e.args.join(" ") === "--session ca-run1-1 close")).toBe(true);
    expect(a.execs.some((e) => e.bin === "pgrep")).toBe(true);
    expect(await codeOf(c.record(versionId))).toBe("RUN_ENDED");
    expect(await codeOf(c.check(browserScenario()))).toBe("RUN_ENDED");
  });

  test("abort kills the in-flight child, closes sessions, moves partial artifacts", async () => {
    const a = new StubAdapter();
    const c = make(a);
    const { versionId } = await c.check(browserScenario());
    await c.record(versionId);
    a.hangNext = true;
    const pending = c.render(versionId, {});
    await new Promise((r) => setTimeout(r, 10));
    await c.abort("interrupted");
    expect(await codeOf(pending)).toBe("ABORTED");
    expect(a.killed).toBeGreaterThan(0);
    expect(c.getState()).toBe("failed");
    expect(c.getReason()).toBe("interrupted");
    expect(existsSync(join(runsDir, "run1", "out"))).toBe(false);
    expect((await readdir(join(runsDir, "run1", "partial"))).length).toBe(1);
    expect(await codeOf(c.doctor())).toBe("RUN_ENDED");
  });

  test("no_finish after two follow-ups", async () => {
    const c = make(new StubAdapter());
    expect((await c.noteModelStopped()).action).toBe("follow_up");
    expect(c.followUpsRemaining()).toBe(1);
    expect((await c.noteModelStopped()).action).toBe("follow_up");
    expect(c.followUpsRemaining()).toBe(0);
    expect((await c.noteModelStopped()).action).toBe("exhausted");
    expect(c.getReason()).toBe("no_finish");
    expect(c.exitCode()).toBe(4);
  });
});

describe("finish validation", () => {
  test("missing and duplicate tiles are refused; state stays inspected", async () => {
    const c = make(new StubAdapter());
    const { renderId, inspectId } = await toInspected(c);
    expect(await codeOf(c.finish({ renderId, inspectId, tiles: tiles(2) }))).toBe("INVALID_VERDICT");
    const dup = [...tiles(3), { ...tiles(1)[0]! }];
    expect(await codeOf(c.finish({ renderId, inspectId, tiles: dup }))).toBe("INVALID_VERDICT");
    expect(await codeOf(c.finish({ renderId, inspectId, tiles: tiles(3, { caption_readable: "not_applicable" }) }))).toBe("INVALID_VERDICT");
    expect(c.getState()).toBe("inspected");
    const r = await c.finish({ renderId, inspectId, tiles: tiles(3, { caption_readable: "not_applicable", reason: "no caption on this step" }) });
    expect(r.accepted).toBe(true);
  });

  test("a stale inspect or mismatched render is refused", async () => {
    const c = make(new StubAdapter());
    const { versionId, renderId, inspectId } = await toInspected(c);
    const r2 = await c.render(versionId, {});
    const i2 = await c.inspect(r2.renderId);
    expect(await codeOf(c.finish({ renderId, inspectId, tiles: tiles() }))).toBe("STALE_EVIDENCE");
    expect(await codeOf(c.finish({ renderId: r2.renderId, inspectId, tiles: tiles() }))).toBe("STALE_EVIDENCE");
    expect(await codeOf(c.inspect(renderId))).toBe("STALE_RENDER");
    expect((await c.finish({ renderId: r2.renderId, inspectId: i2.inspectId, tiles: tiles() })).accepted).toBe(true);
  });

  test("timelineEdited or a privacy issue is never accepted", async () => {
    const a = new StubAdapter();
    const c = make(a);
    const { versionId, renderId, inspectId } = await toInspected(c);
    const r = await c.finish({ renderId, inspectId, tiles: tiles(3, { privacy_issue: "not_applicable", reason: "n/a" }) });
    expect(r.accepted).toBe(false);
    expect(c.getState()).toBe("inspected");
    const orig = a.defaults.render;
    a.handlers.render = async (call) => ({ ...(await orig(call)), timelineEdited: true });
    const r2 = await c.render(versionId, {});
    const i2 = await c.inspect(r2.renderId);
    const v = await c.finish({ renderId: r2.renderId, inspectId: i2.inspectId, tiles: tiles() });
    expect(v.accepted).toBe(false);
    const verdict = JSON.parse(await readFile(join(runsDir, "run1", "verdict.json"), "utf8"));
    expect(verdict).toMatchObject({ accepted: false, timelineEdited: true });
  });
});

describe("desktop approval", () => {
  const desk = (a: Adapter, over: Partial<RunControllerOptions> = {}) => make(a, { allowOrigins: [], allowApps: [APP], ...over });
  const writeApproval = (versionId: string, rec: Record<string, unknown> = {}) =>
    mkdir(join(runsDir, "run1", "approvals"), { recursive: true }).then(() =>
      writeFile(join(runsDir, "run1", "approvals", `${versionId}.json`), JSON.stringify({ route: "cli", at: "t", versionHash: versionId, allowApps: [APP], bundleId: APP, ...rec })));

  test("check writes run.json as approve expects; record without approval hands off without using a capture", async () => {
    const a = new StubAdapter();
    const c = desk(a);
    const r = await c.check(desktopScenario());
    expect(r.requiresApproval).toBe(true);
    expect(r.approveCommand).toContain(`approve run1 ${r.versionId}`);
    expect(a.calls.at(-1)!.flags.allowApps).toEqual([APP]);
    const run = JSON.parse(await readFile(join(runsDir, "run1", "run.json"), "utf8"));
    expect(run).toMatchObject({ allowApps: [APP], bundleId: APP });
    expect(await codeOf(c.record(r.versionId))).toBe("HANDOFF_REQUIRED");
    expect(c.exitCode()).toBe(3);
    expect(c.getReason()).toBe("approval_required");
    expect(c.budget().captures.used).toBe(0);
    expect(a.calls.some((x) => x.cmd === "capture")).toBe(false);
  });

  test("an approval for a different --allow-app set or app is refused", async () => {
    for (const rec of [{ allowApps: [APP, "com.example.other"] }, { bundleId: "com.example.other" }, { versionHash: "f".repeat(64) }]) {
      await rm(join(runsDir, "run1"), { recursive: true, force: true });
      const c = desk(new StubAdapter());
      const { versionId } = await c.check(desktopScenario());
      await writeApproval(versionId, rec);
      expect(await codeOf(c.record(versionId))).toBe("HANDOFF_REQUIRED");
    }
  });

  test("a version modified after approval is refused", async () => {
    const c = desk(new StubAdapter());
    const { versionId } = await c.check(desktopScenario());
    await writeApproval(versionId);
    const p = join(runsDir, "run1", "scenarios", `${versionId}.json`);
    await writeFile(p, (await readFile(p, "utf8")).replace('"7"', '"8"'));
    expect(await codeOf(c.record(versionId))).toBe("VERSION_MODIFIED");
    expect(c.exitCode()).toBe(3);
  });

  test("a matching approval allows recording; deny-listed and unlisted apps are refused at check/explore", async () => {
    const a = new StubAdapter();
    const c = desk(a);
    const { versionId } = await c.check(desktopScenario());
    await writeApproval(versionId);
    await c.record(versionId);
    expect(c.getState()).toBe("recorded");
    const c2 = new RunController({ runsDir, runId: "run2", request: "x", allowApps: ["com.apple.Terminal"], adapter: a, now: () => clock });
    expect(await codeOf(c2.check({ ...desktopScenario(), source: { type: "desktop", app: "com.apple.Terminal" } }))).toBe("INVALID_SCENARIO");
    expect(await codeOf(c2.exploreDesktop("com.apple.Terminal"))).toBe("APP_NOT_ALLOWED");
    const c3 = new RunController({ runsDir, runId: "run3", request: "x", allowApps: [APP], adapter: a, now: () => clock });
    expect(await codeOf(c3.exploreDesktop("com.example.other"))).toBe("APP_NOT_ALLOWED");
    expect((await c3.exploreDesktop(APP)).app).toBe("Calculator");
    expect(await codeOf(c3.check({ ...desktopScenario(), steps: [{ action: "click", target: "@e1" }] }))).toBe("INVALID_SCENARIO");
  });

  test("launcher approval route writes an approval the record step accepts", async () => {
    const c = desk(new StubAdapter());
    const { versionId } = await c.check(desktopScenario());
    expect(c.approvalSummaryFor(versionId)).toContain(versionId);
    await c.recordLauncherApproval(versionId);
    await c.record(versionId);
    expect(c.getState()).toBe("recorded");
  });

  test("resume only from approval-pending, with budgets carried over", async () => {
    const a = new StubAdapter();
    const c = desk(a);
    const { versionId } = await c.check(desktopScenario());
    expect(await codeOf(c.record(versionId))).toBe("HANDOFF_REQUIRED");
    const opts = { runsDir, runId: "run1", request: "demo", allowApps: [APP], adapter: a, now: () => clock };
    expect(await codeOf(RunController.resume(opts))).toBe("RESUME_REFUSED"); // no approval yet
    await writeApproval(versionId);
    expect(await codeOf(RunController.resume({ ...opts, allowApps: [APP, "com.example.other"] }))).toBe("RESUME_REFUSED");
    expect(() => make(a, { allowApps: [APP] })).toThrow(); // a fresh controller cannot reuse the run dir
    const r = await RunController.resume(opts);
    expect(r.getState()).toBe("approved");
    expect(r.budget().toolCalls.used).toBe(2);
    await r.record(versionId);
    expect(r.budget().captures.used).toBe(1);
    // Recorded: no longer resumable.
    expect(await codeOf(RunController.resume(opts))).toBe("RESUME_REFUSED");
  });

  test("a browser run is never resumable", async () => {
    const a = new StubAdapter();
    a.handlers.capture = () => ({ ok: false, retry: "no", code: "X" });
    const c = make(a);
    const { versionId } = await c.check(browserScenario());
    await codeOf(c.record(versionId));
    expect(await codeOf(RunController.resume({ runsDir, runId: "run1", request: "x", allowOrigins: [ORIGIN], adapter: a }))).toBe("RESUME_REFUSED");
  });
});

describe("redaction", () => {
  test("a redacted fill value never appears in any file under runs/", async () => {
    const a = new StubAdapter();
    let first = true;
    const orig = a.defaults.capture;
    a.handlers.capture = async (call) => {
      if (first) {
        first = false;
        return { ok: false, code: "UNEXPECTED", retry: "after-fix", message: `agent-browser fill #pw ${SECRET} exited 1` };
      }
      return orig(call);
    };
    a.handlers.check = () => ({ ok: true, issues: [{ path: "steps[0]", level: "warning", message: `saw ${SECRET}` }] });
    const c = make(a);
    const sc = browserScenario({
      steps: [
        { action: "fill", target: "text=Password", value: SECRET, redact: true, caption: `pw ${SECRET}` },
        { action: "click", target: "text=Submit" },
      ],
    });
    const { versionId } = await c.check(sc);
    expect(await codeOf(c.record(versionId))).toBe("UNEXPECTED");
    await c.record(versionId);
    // The CLI received the real value via a temp file outside runs/.
    const sent = a.captureScenarios.at(-1) as { steps: { value?: string }[] };
    expect(sent.steps[0]!.value).toBe(SECRET);
    const { renderId } = await c.render(versionId, {});
    const { inspectId } = await c.inspect(renderId);
    // Refused call with the secret in its args is redacted too.
    await codeOf(c.check({ ...sc, extra: SECRET }));
    await c.finish({ renderId, inspectId, tiles: tiles(3, { note: SECRET }) });
    const files = await allFiles(join(runsDir, "run1"));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) expect((await readFile(f, "utf8")).includes(SECRET)).toBe(false);
    const stored = JSON.parse(await readFile(join(runsDir, "run1", "scenarios", `${versionId}.json`), "utf8"));
    expect(stored.steps[0].value).toBe("***");
  });
});
