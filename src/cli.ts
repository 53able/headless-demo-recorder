#!/usr/bin/env bun
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { captureBrowser } from "./capture/browser.ts";
import { captureDesktop } from "./capture/desktop.ts";
import { captureFile } from "./capture/file.ts";
import { compileEditor } from "./compile.ts";
import { buildComposite, composeEditor, DEFAULT_SIZE, emptyStreams } from "./compose.ts";
import { doctor } from "./doctor.ts";
import { ToolError, asToolError } from "./errors.ts";
import { barrier, exists, log, requestAbort } from "./exec.ts";
import { inspect } from "./inspect.ts";
import { render } from "./render.ts";
import type { CaptureResult, Composition, EditPlan, Output, Scenario } from "./types.ts";
import { type Issue, isComposition, normalizeOrigin, validateComposition, validateEvents, validateScenario } from "./validate.ts";

const USAGE = `headless capture → edit → export

  doctor                          R0  tools, versions, OS permissions (read-only)
  check   <scenario.json>         R0  validate the scenario; nothing is launched
  capture <scenario.json>         R2  drive the UI and record → <out>.project/capture.mp4 + events.json
  render  <project-dir> [--scenario s.json] [--edit edit.json] [--out file]
                                  R1  compile edits + export from a saved capture (no re-recording)
  inspect <project-dir> [--video file]
                                  R0  one frame per action → inspect-sheet.png for visual review
  plan    <project-dir> [--edit edit.json]
                                  R0  print the editor regions that render would write
  run     <scenario.json>         check → capture → render → inspect
  (check/run take a composition.json too: its scenarios are recorded in parallel and joined;
   render/plan <composition-project> [--composition c.json] re-join and re-export without recording)

Flags: --force (overwrite an existing capture/output), --keep-work (keep raw capture files)
Guards (check/capture/run):
  --allow-origin <origin>   repeatable; every URL must match scheme+host+port; the browser is
                            limited to these hosts (agent-browser --allowed-domains)
  --allow-app <bundleId>    repeatable; desktop input only to these apps (deny list always applies)
  --session-name <name>     agent-browser session to use (default: generated); a composition
                            uses <name>-<scenario name> for each browser scenario
stdout: exactly one JSON object. ok:false carries stage, code, retry (safe | after-fix | no), hint.
stderr: progress logs.`;

type Flags = {
  force: boolean; keepWork: boolean; allowOrigins: string[]; allowApps: string[];
  opts: Record<string, string>; pos: string[];
};

function parseArgs(argv: string[]): Flags {
  const f: Flags = { force: false, keepWork: false, allowOrigins: [], allowApps: [], opts: {}, pos: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--force") f.force = true;
    else if (a === "--keep-work") f.keepWork = true;
    else if (a.startsWith("--")) {
      const v = argv[++i];
      if (v === undefined) throw new ToolError("validate", "BAD_ARGS", `${a} needs a value`, "after-fix", USAGE);
      if (a === "--allow-origin") {
        if (!normalizeOrigin(v)) throw new ToolError("validate", "BAD_ARGS", `--allow-origin ${v}: not an http(s) origin`, "after-fix", USAGE);
        f.allowOrigins.push(v);
      } else if (a === "--allow-app") f.allowApps.push(v);
      else f.opts[a.slice(2)] = v;
    } else f.pos.push(a);
  }
  return f;
}

/** Scenario issues under the guard flags, plus the shape of a file source's events file. */
async function scenarioIssues(raw: unknown, f: Flags): Promise<Issue[]> {
  const issues = validateScenario(raw, { allowOrigins: f.allowOrigins.length ? f.allowOrigins : undefined });
  const src = (raw as Partial<Scenario> | null)?.source;
  if (src?.type === "file" && src.events !== undefined) {
    if (typeof src.events !== "string" || src.events === "") return [...issues, { path: "source.events", level: "error", message: "must be a path to an ActionEvent[] JSON file (or omitted)" }];
    let events: unknown;
    try {
      events = JSON.parse(await readFile(resolve(src.events), "utf8"));
    } catch (e) {
      return [...issues, { path: "source.events", level: "error", message: `cannot read ${src.events}: ${(e as Error).message}` }];
    }
    issues.push(...validateEvents(events, "source.events"));
  }
  return issues;
}

const readJson = async <T>(path: string, stage: "validate" | "render"): Promise<T> => {
  try {
    return JSON.parse(await readFile(resolve(path), "utf8")) as T;
  } catch (e) {
    throw new ToolError(stage, "BAD_JSON", `cannot read ${path}: ${(e as Error).message}`, "after-fix");
  }
};
const projectDirFor = (s: { output: Output }) => {
  const out = resolve(s.output.path);
  return join(dirname(out), `${basename(out).replace(/\.[^.]+$/, "")}.project`);
};

async function loadScenario(path: string, f: Flags): Promise<{ scenario: Scenario; warnings: string[] }> {
  const raw = await readJson<unknown>(path, "validate");
  const issues = await scenarioIssues(raw, f);
  const errors = issues.filter((i) => i.level === "error");
  if (errors.length) {
    throw new ToolError("validate", "INVALID_SCENARIO", errors.map((i) => `${i.path}: ${i.message}`).join("\n"), "after-fix", "fix the listed fields; nothing was launched");
  }
  return { scenario: raw as Scenario, warnings: issues.filter((i) => i.level === "warning").map((i) => `${i.path}: ${i.message}`) };
}

/** Composition issues plus each referenced scenario's issues (prefixed `scenarios[i](<path>).`).
 * A referenced file that cannot be read becomes an issue, never a throw. */
async function compositionIssues(raw: unknown, f: Flags): Promise<{ issues: Issue[]; scenarios: Scenario[] }> {
  const paths: unknown[] = Array.isArray((raw as Partial<Composition>).scenarios) ? (raw as Composition).scenarios : [];
  const issues: Issue[] = [];
  const scenarios: (Scenario | undefined)[] = [];
  for (const [i, p] of paths.entries()) {
    if (typeof p !== "string" || !p) {
      scenarios.push(undefined);
      continue;
    }
    let s: unknown;
    try {
      s = await readJson<unknown>(p, "validate");
    } catch (e) {
      issues.push({ path: `scenarios[${i}]`, level: "error", message: (e as Error).message });
      scenarios.push(undefined);
      continue;
    }
    issues.push(...(await scenarioIssues(s, f)).map((x) => ({ ...x, path: `scenarios[${i}](${p}).${x.path}` })));
    const ignored = ["trim", "idleSpeedupMs", "idleSpeed", "speechCaptions", "redact"].filter((k) => (s as Scenario).edit && k in (s as Scenario).edit!);
    if (ignored.length) issues.push({ path: `scenarios[${i}](${p}).edit`, level: "warning", message: `${ignored.join(", ")} is ignored in a composition` });
    scenarios.push(s as Scenario);
  }
  const names = scenarios.map((s) => (typeof s?.name === "string" ? s.name : undefined));
  issues.push(...validateComposition(raw, names));
  // Project dirs hold the recordings: two scenarios (or the composite) sharing one would overwrite a capture.
  const dirs = scenarios.map((s) => (typeof s?.output?.path === "string" ? projectDirFor(s) : undefined));
  dirs.forEach((d, i) => {
    if (d && dirs.indexOf(d) < i) issues.push({ path: `scenarios[${i}]`, level: "error", message: `output.path gives the same project dir as scenarios[${dirs.indexOf(d)}] (${d}); change one output.path` });
  });
  for (const [i, d] of dirs.entries()) {
    if (d && (await exists(join(d, "composition.json")))) issues.push({ path: `scenarios[${i}]`, level: "error", message: `PROJECT_COLLISION: ${d} is a composition's project; change this scenario's output.path` });
  }
  const c = raw as Partial<Composition>;
  if (typeof c.output?.path === "string") {
    const own = projectDirFor(c as Composition);
    const j = dirs.indexOf(own);
    if (j >= 0) issues.push({ path: "output.path", level: "error", message: `gives the same project dir as scenarios[${j}] (${own}); change one output.path` });
    else if ((await exists(join(own, "capture.json"))) && !(await exists(join(own, "composition.json")))) {
      issues.push({ path: "output.path", level: "error", message: `PROJECT_COLLISION: ${own} holds a single-scenario capture; change output.path` });
    }
  }
  return { issues, scenarios: scenarios as Scenario[] };
}

async function loadComposition(path: string, f: Flags): Promise<{ comp: Composition; scenarios: Scenario[]; warnings: string[] }> {
  const raw = await readJson<unknown>(path, "validate");
  const { issues, scenarios } = await compositionIssues(raw, f);
  const errors = issues.filter((i) => i.level === "error");
  if (errors.length) {
    throw new ToolError("validate", "INVALID_COMPOSITION", errors.map((i) => `${i.path}: ${i.message}`).join("\n"), "after-fix", "fix the listed fields; nothing was launched");
  }
  return { comp: raw as Composition, scenarios, warnings: issues.filter((i) => i.level === "warning").map((i) => `${i.path}: ${i.message}`) };
}

async function doCapture(scenario: Scenario, f: Flags, extra: { sessionName?: string; ready?: () => Promise<void>; runId?: string } = {}): Promise<{ projDir: string; capture: CaptureResult }> {
  const projDir = projectDirFor(scenario);
  if (await exists(join(projDir, "composition.json"))) {
    throw new ToolError("capture", "PROJECT_COLLISION", `${projDir} is a composition's project`, "after-fix", "change this scenario's output.path; nothing was launched");
  }
  if ((await exists(join(projDir, "capture.json"))) && !f.force) {
    throw new ToolError("capture", "CAPTURE_EXISTS", `${projDir} already has a capture`, "after-fix", `re-edit it with: render ${projDir} --scenario <file> (or pass --force to record again)`);
  }
  const work = join(projDir, "work");
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  const steps = scenario.steps ?? [];
  let capture: CaptureResult;
  try {
    switch (scenario.source.type) {
      case "browser": capture = await captureBrowser(scenario.source, steps, work, { allowOrigins: f.allowOrigins, sessionName: extra.sessionName ?? f.opts["session-name"], ready: extra.ready }); break;
      case "desktop": capture = await captureDesktop(scenario.source, steps, work, { allowApps: f.allowApps, ready: extra.ready }); break;
      case "file": capture = await captureFile(scenario.source, work); break;
    }
  } catch (e) {
    // Keep raw files: a failed step may still have produced a usable recording.
    throw asToolError(e, "capture", { workDir: work });
  }
  const video = join(projDir, "capture.mp4");
  await rename(capture.videoPath, video);
  capture = { ...capture, videoPath: video, ...(extra.runId ? { runId: extra.runId } : {}) };
  await writeFile(join(projDir, "capture.json"), JSON.stringify(capture, null, 2));
  await writeFile(join(projDir, "events.json"), JSON.stringify(capture.events, null, 2));
  if (!f.keepWork) await rm(work, { recursive: true, force: true });
  return { projDir, capture };
}

async function loadProject(projDir: string): Promise<CaptureResult> {
  const p = resolve(projDir);
  if (!(await exists(join(p, "capture.json")))) throw new ToolError("render", "NO_CAPTURE", `${p} has no capture.json`, "after-fix", "run `capture <scenario>` first");
  const capture = await readJson<CaptureResult>(join(p, "capture.json"), "render");
  // The video is always the project's own capture.mp4; capture.json's videoPath is not trusted.
  capture.videoPath = join(p, "capture.mp4");
  // events.json is the editable source of truth for timing/captions.
  capture.events = await readJson(join(p, "events.json"), "render");
  const errors = validateEvents(capture.events, "events.json").filter((i) => i.level === "error");
  if (errors.length) {
    const shown = errors.slice(0, 10).map((i) => `${i.path}: ${i.message}`);
    if (errors.length > 10) shown.push(`... and ${errors.length - 10} more`);
    throw new ToolError("render", "INVALID_EVENTS", shown.join("\n"), "after-fix", `fix ${join(p, "events.json")}; the recording is unchanged`);
  }
  return capture;
}

async function editInputs(f: Flags, projDir: string): Promise<{ name: string; plan: EditPlan; output: Output }> {
  const sc = f.opts.scenario ? (await loadScenario(f.opts.scenario, f)).scenario : undefined;
  const plan: EditPlan = f.opts.edit ? await readJson<EditPlan>(f.opts.edit, "render") : (sc?.edit ?? {});
  const name = sc?.name ?? basename(projDir).replace(/\.project$/, "");
  const outPath = f.opts.out ?? sc?.output.path ?? join(dirname(projDir), `${name}.mp4`);
  return { name, plan, output: { ...(sc?.output ?? {}), path: outPath } };
}

/** `<compProj>` already holds a single-scenario recording (capture without composition.json): refuse to overwrite it. */
async function assertCompositeDir(compProj: string, stage: "validate" | "render") {
  if ((await exists(join(compProj, "capture.json"))) && !(await exists(join(compProj, "composition.json")))) {
    throw new ToolError(stage, "PROJECT_COLLISION", `${compProj} holds a single-scenario capture`, "after-fix", "change the composition's output.path; nothing was launched");
  }
}

/** Record every referenced scenario at once; recording starts together at the barrier. */
async function captureAll(scenarios: Scenario[], f: Flags, compositionArg: string, retryRender: string): Promise<{ projectDirs: string[]; startSkewMs: number; warnings: string[] }> {
  const projectDirs = scenarios.map(projectDirFor);
  // Check all before launching anything: a half-started parallel capture is the costly failure.
  if (!f.force) {
    for (const d of projectDirs) {
      if (await exists(join(d, "capture.json"))) throw new ToolError("capture", "CAPTURE_EXISTS", `${d} already has a capture`, "after-fix", `re-join without recording: ${retryRender} (or pass --force to record again)`);
    }
  }
  const base = f.opts["session-name"] ?? `headless-demo-recorder-${process.pid}-${Date.now()}`;
  const runId = `${base}-${Date.now()}`; // unique per run even with a fixed --session-name
  const gate = barrier(scenarios.length, 120_000);
  // allSettled, not all: an early reject would let main exit before the others clean up.
  const settled = await Promise.allSettled(scenarios.map(async (s) => {
    let arrived = false;
    try {
      return await doCapture(s, f, { sessionName: `${base}-${s.name}`, runId, ready: () => ((arrived = true), gate.arrive()) });
    } catch (e) {
      // Failed before recording: stop the others at the barrier rather than let them act alone.
      if (!arrived && s.source.type !== "file") gate.fail(new Error(`${s.name} failed before recording started`));
      throw e;
    } finally {
      if (!arrived) gate.leave(); // a file source never waits at the barrier
    }
  }));
  const failed = settled.flatMap((r, i) => (r.status === "rejected" ? [{ name: scenarios[i]!.name, error: asToolError(r.reason, "capture") }] : []));
  if (failed.length) {
    throw new ToolError("capture", "CAPTURE_PARTIAL_FAILED", failed.map((x) => `${x.name}: [${x.error.code}] ${x.error.message}`).join("\n"), "no",
      `recordings that finished are kept but cannot be time-aligned with a later re-capture. Reset the app state, then record all of them again: run ${compositionArg} --force`,
      { failed: failed.map((x) => x.name).join(","), projectDirs: projectDirs.join(",") });
  }
  const t0s = settled.map((r) => (r.status === "fulfilled" ? r.value.capture.t0EpochMs : undefined));
  const startSkewMs = t0s.every((t) => t !== undefined) ? Math.max(...(t0s as number[])) - Math.min(...(t0s as number[])) : 0;
  const warnings = startSkewMs > 1000 ? [`recordings started ${startSkewMs}ms apart (barrier timed out?); side-by-side scenes may be misaligned`] : [];
  return { projectDirs, startSkewMs, warnings };
}

/** Join the referenced captures into `<compProj>/capture.mp4` and export it. Never records. */
async function renderComposition(compProj: string, comp: Composition, compPath: string, scenarios: Scenario[], f: Flags) {
  const outPath = resolve(comp.output.path);
  if (!f.force && (await exists(outPath))) throw new ToolError("render", "OUTPUT_EXISTS", `${outPath} already exists`, "after-fix", "pass --force to overwrite, or change output.path");
  await assertCompositeDir(compProj, "render");
  const captures: Record<string, CaptureResult> = {};
  for (const s of scenarios) captures[s.name] = await loadProject(projectDirFor(s));
  const { patch, events, scenes } = composeEditor(comp, captures, Object.fromEntries(scenarios.map((s) => [s.name, s.edit])));
  const empty = emptyStreams(scenes);
  if (empty.length) throw new ToolError("render", "EMPTY_SEGMENT", `no video in: ${empty.join(", ")}`, "after-fix", "lower that stream's startMs (it is past the end of the aligned recording)");
  await mkdir(compProj, { recursive: true });
  // Written first: a project with capture.json but no composition.json reads as a single-scenario project.
  await writeFile(join(compProj, "composition.json"), JSON.stringify({ source: resolve(compPath), composition: comp }, null, 2));
  const video = join(compProj, "capture.mp4");
  const probe = await buildComposite(scenes, captures, comp.size ?? DEFAULT_SIZE, video);
  const capture: CaptureResult = { videoPath: video, ...probe, events, realCursor: false };
  await writeFile(join(compProj, "capture.json"), JSON.stringify(capture, null, 2));
  // Derived each render; edit the referenced projects' events.json instead.
  await writeFile(join(compProj, "events.json"), JSON.stringify(events, null, 2));
  return render(compProj, comp.name, capture, { ...comp.edit } as EditPlan, comp.output, { force: f.force, patch });
}

/** `--composition`, else the source recorded in `<projDir>/composition.json`; undefined for a single-scenario project. */
async function compositionFor(projDir: string, f: Flags): Promise<string | undefined> {
  if (f.opts.composition) return f.opts.composition;
  const rec = join(projDir, "composition.json");
  return (await exists(rec)) ? (await readJson<{ source: string }>(rec, "render")).source : undefined;
}

async function loadCompositionFor(projDir: string, path: string, f: Flags) {
  const loaded = await loadComposition(path, f);
  const own = projectDirFor(loaded.comp);
  if (own !== projDir) throw new ToolError("validate", "BAD_ARGS", `${projDir} is not the project dir of ${path} (${own})`, "after-fix", `pass ${own}`);
  return loaded;
}

async function main(argv: string[]): Promise<unknown> {
  const [cmd, ...rest] = argv;
  const f = parseArgs(rest);
  const arg = f.pos[0];
  switch (cmd) {
    case "doctor": {
      const checks = await doctor();
      return { ok: checks.every((c) => c.ok), checks };
    }
    case "check": {
      if (!arg) break;
      const raw = await readJson<unknown>(arg, "validate");
      const issues = isComposition(raw) ? (await compositionIssues(raw, f)).issues : await scenarioIssues(raw, f);
      return { ok: !issues.some((i) => i.level === "error"), issues };
    }
    case "capture": {
      if (!arg) break;
      const { scenario, warnings } = await loadScenario(arg, f);
      const { projDir, capture } = await doCapture(scenario, f);
      return { ok: true, stage: "capture", projectDir: projDir, events: capture.events.length, durationMs: capture.durationMs, warnings, next: [`render ${projDir} --scenario ${arg}`] };
    }
    case "plan": {
      if (!arg) break;
      const compPath = await compositionFor(resolve(arg), f);
      if (compPath) {
        // R0: no ffmpeg, no writes. Lengths come from the referenced captures.
        const { comp, scenarios } = await loadCompositionFor(resolve(arg), compPath, f);
        const captures: Record<string, CaptureResult> = {};
        for (const s of scenarios) captures[s.name] = await loadProject(projectDirFor(s));
        const { patch, scenes } = composeEditor(comp, captures, Object.fromEntries(scenarios.map((s) => [s.name, s.edit])));
        return { ok: true, stage: "compile", durationMs: scenes.reduce((n, s) => n + s.lengthMs, 0), regions: patch };
      }
      const capture = await loadProject(arg);
      const { plan } = await editInputs(f, resolve(arg));
      return { ok: true, stage: "compile", regions: compileEditor(capture, plan) };
    }
    case "render": {
      if (!arg) break;
      const projDir = resolve(arg);
      const compPath = await compositionFor(projDir, f);
      if (compPath) {
        const { comp, scenarios } = await loadCompositionFor(projDir, compPath, f);
        const result = await renderComposition(projDir, comp, compPath, scenarios, f);
        return { ok: true, stage: "render", ...result, next: [`inspect ${projDir} --video ${result.outputPath}`] };
      }
      const capture = await loadProject(projDir);
      const { name, plan, output } = await editInputs(f, projDir);
      const result = await render(projDir, name, capture, plan, output, { force: f.force });
      return { ok: true, stage: "render", ...result, next: [`inspect ${projDir} --video ${result.outputPath}`] };
    }
    case "inspect": {
      if (!arg) break;
      const projDir = resolve(arg);
      const video = f.opts.video ?? join(projDir, "capture.mp4");
      return { ok: true, stage: "inspect", ...(await inspect(projDir, resolve(video))) };
    }
    case "run": {
      if (!arg) break;
      if (isComposition(await readJson<unknown>(arg, "validate"))) {
        const { comp, scenarios, warnings } = await loadComposition(arg, f);
        if (!f.force && (await exists(resolve(comp.output.path)))) {
          throw new ToolError("validate", "OUTPUT_EXISTS", `${resolve(comp.output.path)} already exists`, "after-fix", "pass --force or change output.path; nothing was launched");
        }
        const compProj = projectDirFor(comp);
        await assertCompositeDir(compProj, "validate");
        const rerender = `render ${compProj} --composition ${arg} --force`;
        const { projectDirs, startSkewMs, warnings: skew } = await captureAll(scenarios, f, arg, rerender);
        warnings.push(...skew);
        let result;
        try {
          result = await renderComposition(compProj, comp, arg, scenarios, f);
        } catch (e) {
          // The recordings are saved; only joining and exporting need to be repeated.
          throw asToolError(e, "render", { projectDir: compProj, retryWith: rerender });
        }
        const evidence = await inspect(compProj, result.outputPath);
        return {
          ok: true, stage: "done", ...result, projectDir: compProj, warnings, inspectSheet: evidence.sheet, projectDirs, startSkewMs,
          next: [`view ${evidence.sheet} and confirm each tile shows the acted element`, `${rerender}  (after editing a referenced events.json or the composition)`],
        };
      }
      const { scenario, warnings } = await loadScenario(arg, f);
      // Fail before recording, not after: a wasted capture costs time and repeats app side effects.
      if (!f.force && (await exists(resolve(scenario.output.path)))) {
        throw new ToolError("validate", "OUTPUT_EXISTS", `${resolve(scenario.output.path)} already exists`, "after-fix", "pass --force or change output.path; nothing was launched");
      }
      const { projDir, capture } = await doCapture(scenario, f);
      let result;
      try {
        result = await render(projDir, scenario.name, capture, scenario.edit ?? {}, scenario.output, { force: f.force });
      } catch (e) {
        // The recording is already saved; only rendering needs to be repeated.
        throw asToolError(e, "render", { projectDir: projDir, retryWith: `render ${projDir} --scenario ${arg}` });
      }
      const evidence = await inspect(projDir, result.outputPath);
      return {
        ok: true, stage: "done", ...result, projectDir: projDir, warnings, inspectSheet: evidence.sheet,
        next: [`view ${evidence.sheet} and confirm each tile shows the acted element`, `render ${projDir} --scenario ${arg} --force  (after editing events.json or the edit plan)`],
      };
    }
  }
  throw new ToolError("validate", "BAD_ARGS", `unknown command or missing argument: ${argv.join(" ")}`, "after-fix", USAGE);
}

const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help") {
  console.error(USAGE);
  process.exit(argv.length === 0 ? 2 : 0);
}
// On SIGINT/SIGTERM, abort in-flight work so capture `finally` blocks run (recorder stop,
// agent-browser record stop/close), then exit 130/143 with a JSON error.
let interrupted: { signal: NodeJS.Signals; code: number } | undefined;
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  process.on(signal, () => {
    if (interrupted) process.exit(interrupted.code); // second signal: give up on cleanup
    interrupted = { signal, code };
    log(`${signal}: stopping; cleaning up (send again to exit immediately)`);
    requestAbort(`interrupted by ${signal}`);
    // Cleanup commands have their own timeouts (≤60s); never hang past them.
    setTimeout(() => {
      console.log(JSON.stringify(new ToolError("capture", "INTERRUPTED", `${signal}: cleanup did not finish in time`, "no")));
      process.exit(code);
    }, 90_000).unref();
  });
}

main(argv)
  .then((out) => {
    if (interrupted) throw new Error(`interrupted by ${interrupted.signal}`);
    console.log(JSON.stringify(out));
    process.exit((out as { ok?: boolean }).ok === false ? 1 : 0);
  })
  .catch((e: unknown) => {
    if (interrupted) {
      const m = e instanceof Error ? e.message : String(e);
      const err = new ToolError("capture", "INTERRUPTED", `${m}`, "no", "side effects may have happened; inspect the work dir before retrying", e instanceof ToolError ? e.artifacts : undefined);
      log(err.message);
      console.log(JSON.stringify(err));
      process.exit(interrupted.code);
    }
    const err = asToolError(e, "validate");
    log(err.message);
    console.log(JSON.stringify(err));
    process.exit(err.code === "BAD_ARGS" ? 2 : 1);
  });
