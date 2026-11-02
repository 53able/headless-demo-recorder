#!/usr/bin/env bun
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { captureBrowser } from "./capture/browser.ts";
import { captureDesktop } from "./capture/desktop.ts";
import { captureFile } from "./capture/file.ts";
import { compileEditor } from "./compile.ts";
import { doctor } from "./doctor.ts";
import { approve } from "./approve.ts";
import { ToolError, asToolError } from "./errors.ts";
import { log, requestAbort } from "./exec.ts";
import { inspect } from "./inspect.ts";
import { render } from "./render.ts";
import type { CaptureResult, EditPlan, Output, Scenario } from "./types.ts";
import { type Issue, normalizeOrigin, validateScenario } from "./validate.ts";

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
  approve <runId> <versionHash> [--runs-dir runs]
                                  human approval of a desktop scenario version (TTY only)

Flags: --force (overwrite an existing capture/output), --keep-work (keep raw capture files)
Guards (check/capture/run):
  --allow-origin <origin>   repeatable; every URL must match scheme+host+port; the browser is
                            limited to these hosts (agent-browser --allowed-domains)
  --allow-app <bundleId>    repeatable; desktop input only to these apps (deny list always applies)
  --session-name <name>     agent-browser session to use (default: generated)
  --controller-mode         stricter checks; requires the allowlist for the source type
stdout: exactly one JSON object. ok:false carries stage, code, retry (safe | after-fix | no), hint.
stderr: progress logs.`;

type Flags = {
  force: boolean; keepWork: boolean; controllerMode: boolean; allowOrigins: string[]; allowApps: string[];
  opts: Record<string, string>; pos: string[];
};

function parseArgs(argv: string[]): Flags {
  const f: Flags = { force: false, keepWork: false, controllerMode: false, allowOrigins: [], allowApps: [], opts: {}, pos: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--force") f.force = true;
    else if (a === "--keep-work") f.keepWork = true;
    else if (a === "--controller-mode") f.controllerMode = true;
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

/** Scenario issues under the guard flags. Controller mode fails closed without an allowlist. */
function scenarioIssues(raw: unknown, f: Flags): Issue[] {
  const issues = validateScenario(raw, { allowOrigins: f.allowOrigins.length ? f.allowOrigins : undefined, controllerMode: f.controllerMode });
  const type = (raw as Partial<Scenario> | null)?.source?.type;
  if (f.controllerMode && type === "browser" && !f.allowOrigins.length) issues.push({ path: "--allow-origin", level: "error", message: "required in controller mode" });
  if (f.controllerMode && type === "desktop" && !f.allowApps.length) issues.push({ path: "--allow-app", level: "error", message: "required in controller mode" });
  return issues;
}

const readJson = async <T>(path: string, stage: "validate" | "render"): Promise<T> => {
  try {
    return JSON.parse(await readFile(resolve(path), "utf8")) as T;
  } catch (e) {
    throw new ToolError(stage, "BAD_JSON", `cannot read ${path}: ${(e as Error).message}`, "after-fix");
  }
};
const exists = (p: string) => access(p).then(() => true, () => false);
const projectDirFor = (s: Scenario) => {
  const out = resolve(s.output.path);
  return join(dirname(out), `${basename(out).replace(/\.[^.]+$/, "")}.project`);
};

async function loadScenario(path: string, f: Flags): Promise<{ scenario: Scenario; warnings: string[] }> {
  const raw = await readJson<unknown>(path, "validate");
  const issues = scenarioIssues(raw, f);
  const errors = issues.filter((i) => i.level === "error");
  if (errors.length) {
    throw new ToolError("validate", "INVALID_SCENARIO", errors.map((i) => `${i.path}: ${i.message}`).join("\n"), "after-fix", "fix the listed fields; nothing was launched");
  }
  return { scenario: raw as Scenario, warnings: issues.filter((i) => i.level === "warning").map((i) => `${i.path}: ${i.message}`) };
}

async function doCapture(scenario: Scenario, f: Flags): Promise<{ projDir: string; capture: CaptureResult }> {
  const projDir = projectDirFor(scenario);
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
      case "browser": capture = await captureBrowser(scenario.source, steps, work, { allowOrigins: f.allowOrigins, sessionName: f.opts["session-name"] }); break;
      case "desktop": capture = await captureDesktop(scenario.source, steps, work, { allowApps: f.allowApps, controllerMode: f.controllerMode }); break;
      case "file": capture = await captureFile(scenario.source, work); break;
    }
  } catch (e) {
    // Keep raw files: a failed step may still have produced a usable recording.
    throw asToolError(e, "capture", { workDir: work });
  }
  const video = join(projDir, "capture.mp4");
  await rename(capture.videoPath, video);
  capture = { ...capture, videoPath: video };
  await writeFile(join(projDir, "capture.json"), JSON.stringify(capture, null, 2));
  await writeFile(join(projDir, "events.json"), JSON.stringify(capture.events, null, 2));
  if (!f.keepWork) await rm(work, { recursive: true, force: true });
  return { projDir, capture };
}

async function loadProject(projDir: string): Promise<CaptureResult> {
  const p = resolve(projDir);
  if (!(await exists(join(p, "capture.json")))) throw new ToolError("render", "NO_CAPTURE", `${p} has no capture.json`, "after-fix", "run `capture <scenario>` first");
  const capture = await readJson<CaptureResult>(join(p, "capture.json"), "render");
  // events.json is the editable source of truth for timing/captions.
  capture.events = await readJson(join(p, "events.json"), "render");
  return capture;
}

async function editInputs(f: Flags, projDir: string): Promise<{ name: string; plan: EditPlan; output: Output }> {
  const sc = f.opts.scenario ? (await loadScenario(f.opts.scenario, f)).scenario : undefined;
  const plan: EditPlan = f.opts.edit ? await readJson<EditPlan>(f.opts.edit, "render") : (sc?.edit ?? {});
  const name = sc?.name ?? basename(projDir).replace(/\.project$/, "");
  const outPath = f.opts.out ?? sc?.output.path ?? join(dirname(projDir), `${name}.mp4`);
  return { name, plan, output: { ...(sc?.output ?? {}), path: outPath } };
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
      const issues = scenarioIssues(raw, f);
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
      const capture = await loadProject(arg);
      const { plan } = await editInputs(f, resolve(arg));
      return { ok: true, stage: "compile", regions: compileEditor(capture, plan) };
    }
    case "render": {
      if (!arg) break;
      const projDir = resolve(arg);
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
    case "approve": {
      const versionHash = f.pos[1];
      if (!arg || !versionHash) break;
      const { approval, record } = await approve(resolve(f.opts["runs-dir"] ?? "runs"), arg, versionHash);
      return { ok: true, stage: "approve", approval, ...record };
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
