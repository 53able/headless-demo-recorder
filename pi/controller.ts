// Run controller (plan §3, §3.2, §3.4): state machine, budgets, allowlists from the launch
// config only, immutable scenario versions, controller-generated paths, serialized CLI calls,
// a resource ledger, and cleanup. Pure TS: no @earendil-works/* imports, so pi tools and the
// SDK entry point can wrap it.

import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { bundleRefusal } from "../src/appguard.ts";
import { type Approval, approvalSummary, hashMismatch, runPaths, sha256Hex } from "../src/approve.ts";
import type { ActionEvent, EditPlan, Scenario } from "../src/types.ts";
import { allowedDomains, normalizeOrigin } from "../src/validate.ts";
import { Audit, Redactor } from "./audit.ts";
import {
  type Adapter, type BudgetSnapshot, type Budgets, type CliCommand, type CliResult, DEFAULT_BUDGETS, EXIT_CODES,
  type ExecBin, type ExecResult, type RenderEdits, type RunState, TERMINAL, type Tile,
} from "./types.ts";

export class ControllerError extends Error {
  constructor(public code: string, message: string, public details?: Record<string, unknown>) {
    super(message);
  }
  toJSON() {
    return { ok: false, code: this.code, message: this.message, ...this.details };
  }
}

export type RunControllerOptions = {
  runsDir: string;
  runId?: string;
  request: string;
  /** From the user's launch arguments only (`--allow-origin`). Scenario values are ignored. */
  allowOrigins?: string[];
  /** From the user's launch arguments only (`--allow-app`). */
  allowApps?: string[];
  /** Input files the user named; file sources must resolve (realpath) to one of these. */
  allowFiles?: string[];
  budgets?: Partial<Budgets>;
  adapter: Adapter;
  now?: () => number;
  /** Follow-ups sent when the model stops without finish (plan §3.2). */
  maxFollowUps?: number;
};

type SourceType = "browser" | "desktop" | "file";
type Version = { id: string; path: string; sourceType: SourceType; bundleId?: string; scenario: Scenario; secrets: Map<number, string>; projectDir: string };
type Recording = { versionId: string; projectDir: string; events: number };
type RenderRec = { id: string; versionId: string; projectDir: string; outputPath: string; timelineEdited: boolean };
type InspectRec = { id: string; renderId: string; sheetPath: string; frameCount: number; timelineEdited: boolean | null };
type ExploreEntry = { kind: "browser" | "desktop"; target: string; at: string; snapshot: string };
type CleanupReport = { sessionsClosed: string[]; openscreenRecordPids: number[]; movedPartial: boolean };

const CLEANUP_MARGIN_MS = 30_000;
const EXEC_TIMEOUT_MS = 60_000;
const SNAPSHOT_MAX = 20_000;
const MAX_STEPS = 30;
const MAX_WAIT_MS = 10_000;
const MAX_CAPTION = 40;
const TRI_FIELDS = ["acted_element_visible", "cursor_on_target", "caption_readable", "privacy_issue"] as const;
const IGNORED_ALLOWLIST_KEYS = ["allowOrigins", "allowOrigin", "allowApps", "allowApp", "allowedDomains", "allowFiles"];

const STEP_KEYS: Record<string, string[]> = {
  click: ["target", "caption", "zoom", "redact", "waitMs"],
  fill: ["target", "value", "caption", "zoom", "redact", "waitMs"],
  press: ["key", "caption", "waitMs"],
  scroll: ["direction", "px", "caption", "waitMs"],
  open: ["url", "caption", "waitMs"],
  wait: ["ms", "caption"],
  mark: ["caption", "waitMs"],
};
const SOURCE_KEYS: Record<SourceType, string[]> = {
  browser: ["type", "url", "viewport", "headed"],
  desktop: ["type", "app", "window", "launch", "systemAudio"],
  file: ["type", "path"],
};
const EDIT_KEYS = ["zoom", "syntheticCursor", "stepCaptions", "captionFontSize", "titleFontSize", "titles", "redact"];

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const isInt = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x);
const inRange = (x: unknown, lo: number, hi: number): x is number => typeof x === "number" && Number.isFinite(x) && x >= lo && x <= hi;
const sameSet = (a: unknown, b: string[]) =>
  Array.isArray(a) && a.every((x) => typeof x === "string") && new Set(a).size === new Set(b).size && b.every((x) => a.includes(x));

function unknownKeys(o: Record<string, unknown>, allowed: string[], path: string, errors: string[]) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) errors.push(`${path}.${k}: unknown key`);
}

const refused = (code: string, message: string, details?: Record<string, unknown>) => new ControllerError(code, message, details);

/** Validate `capture_render` edits (plan §3.1). Returns error messages; empty means valid. */
export function validateEdits(e: unknown): string[] {
  const errors: string[] = [];
  if (e === undefined) return errors;
  if (!isObj(e)) return ["edits: must be an object"];
  unknownKeys(e, ["captions", "timeShift", "zoom", "captionFontSize", "titles"], "edits", errors);
  const list = (key: string, check: (item: Record<string, unknown>, p: string) => void, max = 100) => {
    const v = e[key];
    if (v === undefined) return;
    if (!Array.isArray(v)) return errors.push(`edits.${key}: must be an array`);
    if (v.length > max) errors.push(`edits.${key}: at most ${max} items`);
    v.forEach((item, i) => {
      const p = `edits.${key}[${i}]`;
      if (!isObj(item)) return errors.push(`${p}: must be an object`);
      check(item, p);
    });
  };
  list("captions", (c, p) => {
    unknownKeys(c, ["eventIndex", "text"], p, errors);
    if (!isInt(c.eventIndex) || c.eventIndex < 0) errors.push(`${p}.eventIndex: non-negative integer`);
    if (typeof c.text !== "string" || c.text.length > MAX_CAPTION) errors.push(`${p}.text: string of at most ${MAX_CAPTION} chars`);
  });
  list("timeShift", (c, p) => {
    unknownKeys(c, ["eventIndex", "deltaMs"], p, errors);
    if (!isInt(c.eventIndex) || c.eventIndex < 0) errors.push(`${p}.eventIndex: non-negative integer`);
    if (!inRange(c.deltaMs, -1500, 1500)) errors.push(`${p}.deltaMs: -1500..1500`);
  });
  list("titles", (t, p) => {
    unknownKeys(t, ["text", "startMs", "endMs"], p, errors);
    if (typeof t.text !== "string" || !t.text || t.text.length > MAX_CAPTION) errors.push(`${p}.text: 1..${MAX_CAPTION} chars`);
    if (!inRange(t.startMs, 0, 3_600_000) || !inRange(t.endMs, 0, 3_600_000) || (t.endMs as number) <= (t.startMs as number)) errors.push(`${p}: 0 <= startMs < endMs`);
  }, 3);
  if (e.zoom !== undefined) {
    if (!isObj(e.zoom)) errors.push("edits.zoom: must be an object");
    else {
      unknownKeys(e.zoom, ["depth", "leadMs", "holdMs"], "edits.zoom", errors);
      if (e.zoom.depth !== undefined && !(isInt(e.zoom.depth) && e.zoom.depth >= 1 && e.zoom.depth <= 6)) errors.push("edits.zoom.depth: integer 1..6");
      if (e.zoom.leadMs !== undefined && !inRange(e.zoom.leadMs, 0, 2000)) errors.push("edits.zoom.leadMs: 0..2000");
      if (e.zoom.holdMs !== undefined && !inRange(e.zoom.holdMs, 0, 4000)) errors.push("edits.zoom.holdMs: 0..4000");
    }
  }
  if (e.captionFontSize !== undefined && !inRange(e.captionFontSize, 16, 120)) errors.push("edits.captionFontSize: 16..120");
  return errors;
}

/** Fill values marked `redact: true` anywhere in a (possibly invalid) scenario. */
export function redactedFillValues(raw: unknown): string[] {
  if (!isObj(raw) || !Array.isArray(raw.steps)) return [];
  return raw.steps.flatMap((s) => (isObj(s) && s.action === "fill" && s.redact === true && typeof s.value === "string" ? [s.value] : []));
}

const newRunId = (t: number) => `${new Date(t).toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-")}-${Math.random().toString(36).slice(2, 8)}`;

export class RunController {
  readonly runId: string;
  readonly runsDir: string;
  readonly runDir: string;
  readonly request: string;
  readonly allowOrigins: readonly string[];
  readonly allowApps: readonly string[];
  readonly redactor = new Redactor();
  private readonly allowFiles: readonly string[];
  private readonly audit: Audit;
  private readonly adapter: Adapter;
  private readonly now: () => number;
  private readonly limits: Budgets;
  private readonly maxFollowUps: number;
  private readonly allowedNorm: string[];
  private readonly baseSession: string;

  private state: RunState = "ready";
  private reason = "";
  private stopping = false;
  private queue: Promise<unknown> = Promise.resolve();
  private startedAt: number;
  private used = { captures: 0, rerenders: 0, toolCalls: 0, renders: 0 };
  private followUps = 0;
  private versions = new Map<string, Version>();
  private lastVersionId?: string;
  private recordings = new Map<string, Recording>();
  private renders: RenderRec[] = [];
  private inspects: InspectRec[] = [];
  private explore: ExploreEntry[] = [];
  private ledger = { sessions: [] as string[], pids: [] as number[] };
  private sessionSeq = 0;
  private takeSeq = 0;
  private cleanupReport?: CleanupReport;

  constructor(opts: RunControllerOptions, internal: { resuming?: boolean } = {}) {
    this.now = opts.now ?? Date.now;
    this.runsDir = resolve(opts.runsDir);
    this.runId = opts.runId ?? newRunId(this.now());
    runPaths(this.runsDir, this.runId, "0".repeat(64)); // validates the runId format
    this.runDir = join(this.runsDir, this.runId);
    if (!internal.resuming && existsSync(join(this.runDir, "budget.json"))) {
      throw refused("RUN_EXISTS", `${this.runDir} already holds a run; use RunController.resume for an approval-pending run`);
    }
    this.request = opts.request;
    this.allowOrigins = [...(opts.allowOrigins ?? [])];
    this.allowApps = [...(opts.allowApps ?? [])];
    this.allowFiles = [...(opts.allowFiles ?? [])];
    this.allowedNorm = this.allowOrigins.map((o) => {
      const n = normalizeOrigin(o);
      if (!n) throw refused("BAD_CONFIG", `--allow-origin ${o}: not an http(s) origin`);
      return n;
    });
    this.limits = { ...DEFAULT_BUDGETS, ...opts.budgets };
    this.maxFollowUps = opts.maxFollowUps ?? 2;
    this.adapter = opts.adapter;
    this.audit = new Audit(this.runDir, this.redactor);
    this.startedAt = this.now();
    this.baseSession = `ca-${this.runId}`.replace(/[^\w-]/g, "-");
  }

  // ---- public status -------------------------------------------------------------------

  getState(): RunState {
    return this.state;
  }
  getReason(): string {
    return this.reason;
  }
  /** Process exit code once terminal (finished 0, failed 1, handoff 3, exhausted 4); null while running. */
  exitCode(): number | null {
    return EXIT_CODES[this.state] ?? null;
  }
  followUpsRemaining(): number {
    return Math.max(0, this.maxFollowUps - this.followUps);
  }
  budget(): BudgetSnapshot {
    return {
      captures: { used: this.used.captures, max: this.limits.captures },
      rerenders: { used: this.used.rerenders, max: this.limits.rerenders },
      toolCalls: { used: this.used.toolCalls, max: this.limits.toolCalls },
      renders: this.used.renders,
      deadlineMs: this.limits.deadlineMs,
      elapsedMs: this.now() - this.startedAt,
    };
  }
  getLedger(): { sessions: string[]; pids: number[] } {
    return { sessions: [...this.ledger.sessions], pids: [...this.ledger.pids] };
  }

  // ---- tools (plan §3.1) ---------------------------------------------------------------

  doctor(): Promise<unknown> {
    return this.call("doctor", {}, async () => {
      const r = await this.runCli("doctor", []);
      if (r.json.ok === false) {
        await this.terminate("handoff", "doctor");
        throw refused("DOCTOR_FAILED", "required tools or permissions are missing; a human must fix them", { checks: r.json.checks });
      }
      return r.json;
    });
  }

  exploreBrowser(url: string): Promise<{ url: string; snapshot: string }> {
    return this.call("explore_browser", { url }, async () => {
      this.requireState(["ready", "checked", "approved"], "explore");
      const n = typeof url === "string" ? normalizeOrigin(url) : undefined;
      if (!n || !this.allowedNorm.includes(n)) throw refused("ORIGIN_NOT_ALLOWED", `${n ?? url} is not in --allow-origin (${this.allowOrigins.join(", ") || "none"})`);
      const session = this.newSession();
      const base = ["--session", session, "--allowed-domains", allowedDomains([...this.allowOrigins]), "--content-boundaries", "--max-output", String(SNAPSHOT_MAX)];
      let snap: ExecResult;
      try {
        const open = await this.exec("agent-browser", [...base, "open", url]);
        if (open.code !== 0) throw refused("EXPLORE_FAILED", `agent-browser open failed: ${open.stderr.slice(-800) || open.stdout.slice(-800)}`);
        await this.exec("agent-browser", [...base, "wait", "--load", "networkidle"]);
        snap = await this.exec("agent-browser", [...base, "snapshot", "-i"]);
        if (snap.code !== 0) throw refused("EXPLORE_FAILED", `agent-browser snapshot failed: ${snap.stderr.slice(-800)}`);
      } finally {
        await this.adapter.exec("agent-browser", ["--session", session, "close"], { timeoutMs: EXEC_TIMEOUT_MS }).catch(() => undefined);
      }
      const snapshot = snap.stdout.slice(0, SNAPSHOT_MAX);
      await this.addExplore("browser", url, snapshot);
      return { url, snapshot };
    });
  }

  exploreDesktop(bundleId: string): Promise<{ bundleId: string; app: string; snapshot: string }> {
    return this.call("explore_desktop", { bundleId }, async () => {
      this.requireState(["ready", "checked", "approved"], "explore");
      if (!this.allowApps.length) throw refused("APP_NOT_ALLOWED", "no --allow-app was given at launch");
      const why = bundleRefusal(typeof bundleId === "string" ? bundleId : undefined, [...this.allowApps]);
      if (why) throw refused("APP_NOT_ALLOWED", why);
      const launch = await this.exec("agent-desktop", ["launch", bundleId, "--activate"]);
      let app: string | undefined;
      try {
        const env = JSON.parse(launch.stdout) as { ok?: boolean; data?: { app?: string } };
        app = env.ok ? env.data?.app : undefined;
      } catch {
        app = undefined;
      }
      if (!app) throw refused("EXPLORE_FAILED", `agent-desktop launch ${bundleId} failed: ${(launch.stdout || launch.stderr).slice(-800)}`);
      const snap = await this.exec("agent-desktop", ["snapshot", "--app", app, "-i", "--compact"]);
      if (snap.code !== 0) throw refused("EXPLORE_FAILED", `agent-desktop snapshot failed: ${(snap.stdout || snap.stderr).slice(-800)}`);
      const snapshot = snap.stdout.slice(0, SNAPSHOT_MAX);
      await this.addExplore("desktop", bundleId, snapshot);
      return { bundleId, app, snapshot };
    });
  }

  check(scenario: unknown): Promise<{ versionId: string; sourceType: SourceType; warnings: string[]; requiresApproval: boolean; approveCommand?: string }> {
    // Secrets are registered before anything (including a refusal) is written.
    for (const v of redactedFillValues(scenario)) this.redactor.add(v);
    return this.call("check", { scenario }, async () => {
      this.requireState(["ready", "checked", "approved", "recorded", "rendered", "inspected"], "check");
      const { errors, warnings, scenario: sc, sourceType, bundleId } = await this.preValidate(scenario);
      if (errors.length) throw refused("INVALID_SCENARIO", errors.join("\n"), { issues: errors, warnings, retry: "after-fix" });

      const take = ++this.takeSeq;
      const outPath = join(this.runDir, "out", `take-${take}`, `${sc.name}.mp4`);
      sc.output = { ...sc.output, path: outPath };
      const secrets = new Map<number, string>();
      (sc.steps ?? []).forEach((s, i) => {
        if (s.action === "fill" && s.redact) secrets.set(i, s.value);
      });
      const stored = this.redactor.apply(sc);
      const bytes = JSON.stringify(stored, null, 2);
      const hash = sha256Hex(bytes);
      const paths = runPaths(this.runsDir, this.runId, hash);
      const staging = join(dirname(paths.scenario), `.staging-${hash}.json`);
      await mkdir(dirname(staging), { recursive: true });
      await writeFile(staging, bytes);
      let r: CliResult;
      try {
        r = await this.runCli("check", [staging]);
      } catch (e) {
        await rm(staging, { force: true });
        throw e;
      }
      const issues = Array.isArray(r.json.issues) ? (r.json.issues as { path: string; level: string; message: string }[]) : [];
      const cliWarnings = issues.filter((i) => i.level === "warning").map((i) => `${i.path}: ${i.message}`);
      if (r.json.ok !== true) {
        await rm(staging, { force: true });
        const errs = issues.filter((i) => i.level === "error").map((i) => `${i.path}: ${i.message}`);
        throw refused("INVALID_SCENARIO", errs.join("\n") || String(r.json.message ?? "check failed"), { issues: errs, warnings: [...warnings, ...cliWarnings], retry: "after-fix" });
      }
      if (existsSync(paths.scenario)) await rm(staging, { force: true });
      else await rename(staging, paths.scenario);

      const projectDir = join(dirname(outPath), `${basename(outPath).replace(/\.[^.]+$/, "")}.project`);
      this.versions.set(hash, { id: hash, path: paths.scenario, sourceType, bundleId, scenario: stored, secrets, projectDir });
      this.lastVersionId = hash;
      await this.audit.writeJson("run.json", { runId: this.runId, sourceType, allowOrigins: this.allowOrigins, allowApps: this.allowApps, bundleId });
      this.state = "checked";
      const desktop = sourceType === "desktop";
      return {
        versionId: hash, sourceType, warnings: [...warnings, ...cliWarnings, ...this.exploreWarnings(sc)], requiresApproval: desktop,
        ...(desktop ? { approveCommand: this.approveCommand(hash) } : {}),
      };
    });
  }

  record(versionId: string): Promise<{ versionId: string; events: number; durationMs: unknown; warnings: unknown; capturesRemaining: number }> {
    return this.call("record", { versionId }, async () => {
      this.requireState(["checked", "approved", "recorded", "rendered", "inspected"], "record");
      const v = this.versions.get(versionId);
      if (!v) throw refused("UNKNOWN_VERSION", `no checked version ${versionId} in this run; call check first`);
      const mismatch = hashMismatch(await readFile(v.path), versionId);
      if (mismatch) {
        await this.terminate("handoff", "version_modified");
        throw refused("VERSION_MODIFIED", mismatch);
      }
      if (v.sourceType === "desktop") {
        const why = await this.approvalProblem(v);
        if (why) {
          await this.audit.writeJson("request.json", { request: this.request, versionId });
          await this.terminate("handoff", "approval_required");
          throw refused("HANDOFF_REQUIRED", `desktop recording needs human approval (${why}). Run in a terminal: ${this.approveCommand(versionId)} ; then resume with: bun bin/make.ts --resume ${this.runId}`, { approveCommand: this.approveCommand(versionId) });
        }
        this.state = "approved";
      }
      if (this.used.captures >= this.limits.captures) {
        await this.terminate("exhausted", "captures");
        throw refused("BUDGET_EXHAUSTED", `capture budget used up (${this.limits.captures})`);
      }
      this.used.captures++; // consumed at attempt start, never refunded
      await this.persistBudget();
      const session = v.sourceType === "browser" ? this.newSession() : this.baseSession;
      let tmp: string | undefined;
      let r: CliResult;
      try {
        let scenarioPath = v.path;
        if (v.secrets.size) {
          // Real values never touch runs/<id>/: a private temp copy outside the run dir.
          tmp = await mkdtemp(join(tmpdir(), "headless-demo-recorder-"));
          const real = structuredClone(v.scenario);
          for (const [i, value] of v.secrets) {
            const s = real.steps?.[i];
            if (s?.action === "fill") s.value = value;
          }
          scenarioPath = join(tmp, "scenario.json");
          await writeFile(scenarioPath, JSON.stringify(real), { mode: 0o600 });
        }
        r = await this.runCli("capture", [scenarioPath, "--force"], { session });
      } finally {
        if (tmp) await rm(tmp, { recursive: true, force: true });
      }
      const capturesRemaining = this.limits.captures - this.used.captures;
      if (r.json.ok !== true) throw refused(String(r.json.code ?? "CAPTURE_FAILED"), String(r.json.message ?? "capture failed"), { cli: r.json, capturesRemaining });
      const events = typeof r.json.events === "number" ? r.json.events : 0;
      this.recordings.set(versionId, { versionId, projectDir: v.projectDir, events });
      this.state = "recorded";
      return { versionId, events, durationMs: r.json.durationMs, warnings: r.json.warnings, capturesRemaining };
    });
  }

  render(versionId: string, edits: RenderEdits = {}): Promise<{ renderId: string; durationMs: unknown; timelineEdited: boolean; rerendersRemaining: number }> {
    return this.call("render", { versionId, edits }, async () => {
      this.requireState(["recorded", "rendered", "inspected", "checked", "approved"], "render");
      const errors = validateEdits(edits);
      if (errors.length) throw refused("INVALID_EDITS", errors.join("\n"), { retry: "after-fix" });
      const rec = this.recordings.get(versionId);
      const v = this.versions.get(versionId);
      if (!rec || !v) throw refused("NOT_RECORDED", `version ${versionId} has no recording in this run`);
      const origPath = join(rec.projectDir, "events.orig.json");
      if (!existsSync(origPath)) await copyFile(join(rec.projectDir, "events.json"), origPath);
      const events = JSON.parse(await readFile(origPath, "utf8")) as ActionEvent[];
      const bad = [...(edits.captions ?? []), ...(edits.timeShift ?? [])].filter((x) => x.eventIndex >= events.length);
      if (bad.length) throw refused("INVALID_EDITS", `eventIndex out of range (0..${events.length - 1}): ${bad.map((b) => b.eventIndex).join(", ")}`, { retry: "after-fix" });

      if (this.used.renders >= 1) {
        if (this.used.rerenders >= this.limits.rerenders) {
          await this.terminate("exhausted", "rerenders");
          throw refused("BUDGET_EXHAUSTED", `re-render budget used up (${this.limits.rerenders})`);
        }
        this.used.rerenders++;
      }
      const n = ++this.used.renders;
      await this.persistBudget();

      // Edits always apply to the original capture's events, so each render is reproducible.
      const patched = events.map((e) => ({ ...e }));
      for (const c of edits.captions ?? []) patched[c.eventIndex]!.caption = c.text;
      for (const s of edits.timeShift ?? []) patched[s.eventIndex]!.tMs = Math.max(0, patched[s.eventIndex]!.tMs + s.deltaMs);
      patched.sort((a, b) => a.tMs - b.tMs);
      await writeFile(join(rec.projectDir, "events.json"), JSON.stringify(this.redactor.apply(patched), null, 2));
      const base: EditPlan = { ...(v.scenario.edit ?? {}) };
      const plan: EditPlan = {
        ...base,
        ...(edits.zoom ? { zoom: { ...base.zoom, ...edits.zoom } as EditPlan["zoom"] } : {}),
        ...(edits.captionFontSize !== undefined ? { captionFontSize: edits.captionFontSize } : {}),
        ...(edits.titles ? { titles: edits.titles } : {}),
      };
      const editPath = await this.audit.writeJson(join("out", `edit-${n}.json`), plan);
      const outputPath = join(this.runDir, "out", `render-${n}.mp4`);
      const r = await this.runCli("render", [rec.projectDir, "--edit", editPath, "--out", outputPath, "--force"]);
      const rerendersRemaining = this.limits.rerenders - this.used.rerenders;
      if (r.json.ok !== true) throw refused(String(r.json.code ?? "RENDER_FAILED"), String(r.json.message ?? "render failed"), { cli: r.json, rerendersRemaining });
      const timelineEdited = r.json.timelineEdited !== false; // unknown counts as edited (not auto-accepted)
      const id = `render-${n}`;
      this.renders.push({ id, versionId, projectDir: rec.projectDir, outputPath, timelineEdited });
      this.state = "rendered";
      return { renderId: id, durationMs: r.json.durationMs, timelineEdited, rerendersRemaining };
    });
  }

  inspect(renderId: string): Promise<{ inspectId: string; sheetPath: string; frames: unknown[]; timelineEdited: boolean | null; note?: unknown }> {
    return this.call("inspect", { renderId }, async () => {
      this.requireState(["rendered", "inspected"], "inspect");
      const latest = this.renders.at(-1);
      if (!latest || latest.id !== renderId) throw refused("STALE_RENDER", `only the latest render (${latest?.id ?? "none"}) can be inspected`);
      const r = await this.runCli("inspect", [latest.projectDir, "--video", latest.outputPath]);
      if (r.json.ok !== true || typeof r.json.sheet !== "string") throw refused(String(r.json.code ?? "INSPECT_FAILED"), String(r.json.message ?? "inspect returned no sheet"), { cli: r.json });
      const n = this.inspects.length + 1;
      const sheetPath = join(this.runDir, "out", `inspect-${n}.png`);
      await copyFile(r.json.sheet, sheetPath); // the project's sheet is overwritten by the next inspect
      const frames = Array.isArray(r.json.frames) ? r.json.frames : [];
      const timelineEdited = typeof r.json.timelineEdited === "boolean" ? r.json.timelineEdited : null;
      const id = `inspect-${n}`;
      this.inspects.push({ id, renderId, sheetPath, frameCount: frames.length, timelineEdited });
      this.state = "inspected";
      return { inspectId: id, sheetPath, frames, timelineEdited, note: r.json.note };
    });
  }

  finish(input: { renderId: string; inspectId: string; tiles: Tile[] }): Promise<{ accepted: boolean; failed: { index: number; fields: string[] }[]; rerendersRemaining: number; verdictPath: string }> {
    return this.call("finish", input, async () => {
      this.requireState(["inspected"], "finish");
      const render = this.renders.at(-1);
      const insp = this.inspects.at(-1);
      if (!isObj(input) || !render || !insp || input.renderId !== render.id || input.inspectId !== insp.id || insp.renderId !== render.id) {
        throw refused("STALE_EVIDENCE", `finish must cite the latest render (${render?.id ?? "none"}) and its latest inspect (${insp?.id ?? "none"})`);
      }
      const errors: string[] = [];
      const tiles = Array.isArray(input.tiles) ? input.tiles : (errors.push("tiles: must be an array"), []);
      const seen = new Set<number>();
      tiles.forEach((t, i) => {
        const p = `tiles[${i}]`;
        if (!isObj(t)) return errors.push(`${p}: must be an object`);
        unknownKeys(t, ["index", ...TRI_FIELDS, "reason", "note"], p, errors);
        if (!isInt(t.index) || t.index < 0 || t.index >= insp.frameCount) errors.push(`${p}.index: must be 0..${insp.frameCount - 1}`);
        else if (seen.has(t.index)) errors.push(`${p}.index: duplicate tile ${t.index}`);
        else seen.add(t.index);
        let na = false;
        for (const f of TRI_FIELDS) {
          const v = t[f];
          if (v === "not_applicable") na = true;
          else if (typeof v !== "boolean") errors.push(`${p}.${f}: boolean or "not_applicable"`);
        }
        if (na && (typeof t.reason !== "string" || !t.reason.trim())) errors.push(`${p}.reason: required when a field is "not_applicable"`);
      });
      const missing = Array.from({ length: insp.frameCount }, (_, i) => i).filter((i) => !seen.has(i));
      if (missing.length) errors.push(`tiles missing for frame index ${missing.join(", ")}`);
      if (errors.length) throw refused("INVALID_VERDICT", errors.join("\n"), { retry: "after-fix" });

      const failed = tiles.flatMap((t) => {
        const fields = TRI_FIELDS.filter((f) => (f === "privacy_issue" ? t[f] !== false : t[f] === false));
        return fields.length ? [{ index: t.index, fields: [...fields] }] : [];
      });
      const timelineEdited = render.timelineEdited || insp.timelineEdited !== false;
      const accepted = failed.length === 0 && !timelineEdited;
      const verdictPath = await this.audit.writeJson("verdict.json", {
        accepted, at: new Date(this.now()).toISOString(), renderId: render.id, inspectId: insp.id, versionId: render.versionId,
        outputPath: render.outputPath, sheetPath: insp.sheetPath, timelineEdited, failed, tiles,
      });
      const rerendersRemaining = this.limits.rerenders - this.used.rerenders;
      if (accepted) await this.terminate("finished", "accepted");
      else if (rerendersRemaining <= 0) await this.terminate("exhausted", "quality");
      return { accepted, failed, rerendersRemaining, verdictPath };
    });
  }

  // ---- host-only operations (not model tools) -------------------------------------------

  /** Call when the model ended a turn without finish. Two follow-ups, then exhausted (no_finish). */
  noteModelStopped(): Promise<{ action: "follow_up" | "exhausted" | "none"; followUpsRemaining: number; message?: string }> {
    return this.internal(async () => {
      if (TERMINAL.has(this.state)) return { action: "none" as const, followUpsRemaining: this.followUpsRemaining() };
      this.followUps++;
      if (this.followUps > this.maxFollowUps) {
        this.followUps = this.maxFollowUps;
        await this.terminate("exhausted", "no_finish");
        return { action: "exhausted" as const, followUpsRemaining: 0 };
      }
      await this.persistBudget();
      return { action: "follow_up" as const, followUpsRemaining: this.followUpsRemaining(), message: "Call capture_finish now with the latest renderId, inspectId and one tile per frame, then stop." };
    });
  }

  /** Text the launcher shows before `ctx.ui.confirm` (plan §3.4 route 1). */
  approvalSummaryFor(versionId: string): string {
    const v = this.versions.get(versionId);
    if (!v || v.sourceType !== "desktop" || !v.bundleId) throw refused("UNKNOWN_VERSION", `no desktop version ${versionId}`);
    return approvalSummary(v.scenario, [...this.allowApps], v.bundleId, versionId);
  }

  /** Route 1: the launcher calls this only after the user said Yes in `ctx.ui.confirm`. Never a model tool. */
  recordLauncherApproval(versionId: string): Promise<string> {
    return this.internal(async () => {
      const v = this.versions.get(versionId);
      if (!v || v.sourceType !== "desktop" || !v.bundleId) throw refused("UNKNOWN_VERSION", `no desktop version ${versionId}`);
      const mismatch = hashMismatch(await readFile(v.path), versionId);
      if (mismatch) throw refused("VERSION_MODIFIED", mismatch);
      const record: Approval = { route: "launcher", at: new Date(this.now()).toISOString(), versionHash: versionId, allowApps: [...this.allowApps], bundleId: v.bundleId };
      return this.audit.writeJson(join("approvals", `${versionId}.json`), record);
    });
  }

  /** Stop accepting calls, kill the in-flight child, clean up, and end in `state`. */
  async abort(reason: string, state: "failed" | "exhausted" | "handoff" = "failed"): Promise<void> {
    if (TERMINAL.has(this.state) && !this.stopping) return;
    this.stopping = true;
    await this.adapter.killInFlight().catch(() => undefined);
    await this.queue.catch(() => undefined);
    await this.terminate(state, reason);
  }

  /** Resume an approval-pending desktop run (checked, not recorded). Budgets carry over. */
  static async resume(opts: Omit<RunControllerOptions, "budgets"> & { runId: string }): Promise<RunController> {
    const runDir = join(resolve(opts.runsDir), opts.runId);
    let saved: Record<string, unknown>;
    try {
      saved = JSON.parse(await readFile(join(runDir, "budget.json"), "utf8")) as Record<string, unknown>;
    } catch (e) {
      throw refused("RESUME_REFUSED", `cannot read ${join(runDir, "budget.json")}: ${(e as Error).message}`);
    }
    const st = saved.state as RunState;
    const pending = saved.sourceType === "desktop" && saved.recorded === false && typeof saved.versionId === "string"
      && (st === "checked" || st === "approved" || (st === "handoff" && saved.reason === "approval_required"));
    if (!pending) throw refused("RESUME_REFUSED", `run ${opts.runId} is not waiting for desktop approval (state ${st}${saved.reason ? `, ${String(saved.reason)}` : ""})`);
    const lim = saved.limits as Budgets;
    const c = new RunController({ ...opts, budgets: lim }, { resuming: true });
    const used = saved.used as RunController["used"];
    c.used = { ...used };
    c.followUps = Number(saved.followUps ?? 0);
    c.startedAt = c.now() - Number(saved.elapsedMs ?? 0);
    c.takeSeq = Number(saved.takeSeq ?? 0);
    c.sessionSeq = Number(saved.sessionSeq ?? 0);

    const versionId = saved.versionId as string;
    const paths = runPaths(c.runsDir, c.runId, versionId);
    const bytes = await readFile(paths.scenario).catch(() => {
      throw refused("RESUME_REFUSED", `version file ${paths.scenario} is missing`);
    });
    const mismatch = hashMismatch(bytes, versionId);
    if (mismatch) throw refused("RESUME_REFUSED", mismatch);
    const scenario = JSON.parse(bytes.toString("utf8")) as Scenario;
    if ((scenario.steps ?? []).some((s) => s.action === "fill" && s.redact)) {
      throw refused("RESUME_REFUSED", "this version types redacted values, which are not persisted; start a new run");
    }
    const bundleId = c.resolveBundleId(scenario);
    if (!bundleId) throw refused("RESUME_REFUSED", "the version's app does not resolve to an --allow-app bundle ID");
    const out = scenario.output.path;
    const v: Version = {
      id: versionId, path: paths.scenario, sourceType: "desktop", bundleId, scenario, secrets: new Map(),
      projectDir: join(dirname(out), `${basename(out).replace(/\.[^.]+$/, "")}.project`),
    };
    const why = await c.approvalProblem(v);
    if (why) throw refused("RESUME_REFUSED", why);
    c.versions.set(versionId, v);
    c.lastVersionId = versionId;
    c.explore = await readFile(join(runDir, "explore.json"), "utf8").then((t) => (JSON.parse(t) as { entries: ExploreEntry[] }).entries, () => []);
    c.state = "approved";
    await c.persistBudget();
    return c;
  }

  // ---- internals -----------------------------------------------------------------------

  /** Serialize a model tool call: count it, gate it, audit it, persist the budget. */
  private call<T>(tool: string, args: unknown, fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      this.used.toolCalls++;
      let result: T | undefined;
      let error: unknown;
      try {
        await this.gate();
        result = this.redactor.apply(await fn());
        return result;
      } catch (e) {
        error = e instanceof ControllerError ? e : await this.unexpected(e);
        throw error;
      } finally {
        await this.audit.append({
          t: new Date(this.now()).toISOString(), tool, args,
          ...(error ? { error: error instanceof ControllerError ? error.toJSON() : String(error) } : { result }),
          budget: this.budget(),
        }).catch(() => undefined);
        await this.persistBudget().catch(() => undefined);
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  /** Serialize a host operation (not counted as a tool call). */
  private internal<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => undefined);
    return p;
  }

  private async gate(): Promise<void> {
    if (TERMINAL.has(this.state)) throw refused("RUN_ENDED", `run is ${this.state} (${this.reason}); no further calls are accepted`);
    if (this.stopping) throw refused("RUN_ENDED", "run is stopping; no further calls are accepted");
    if (this.used.toolCalls > this.limits.toolCalls) {
      await this.terminate("exhausted", "tool_calls");
      throw refused("BUDGET_EXHAUSTED", `tool-call budget used up (${this.limits.toolCalls})`);
    }
    if (this.now() - this.startedAt >= this.limits.deadlineMs) {
      await this.terminate("exhausted", "deadline");
      throw refused("DEADLINE", `deadline of ${this.limits.deadlineMs}ms passed`);
    }
  }

  private async unexpected(e: unknown): Promise<ControllerError> {
    const message = e instanceof Error ? e.message : String(e);
    await this.terminate("failed", "unexpected").catch(() => undefined);
    return refused("UNEXPECTED", message);
  }

  private requireState(allowed: RunState[], what: string) {
    if (!allowed.includes(this.state)) throw refused("BAD_STATE", `${what} is not allowed in state ${this.state}`);
  }

  /** Per-call timeout: remaining deadline minus the cleanup margin. */
  private async callTimeout(cap = Infinity): Promise<number> {
    const t = Math.min(cap, this.limits.deadlineMs - (this.now() - this.startedAt) - CLEANUP_MARGIN_MS);
    if (t <= 0) {
      await this.terminate("exhausted", "deadline");
      throw refused("DEADLINE", "not enough time left before the deadline (cleanup margin 30s)");
    }
    return t;
  }

  private async runCli(cmd: CliCommand, args: string[], opts: { session?: string } = {}): Promise<CliResult> {
    const timeoutMs = await this.callTimeout();
    const r = await this.adapter.cli({
      cmd, args, timeoutMs, onSpawn: (pid) => this.ledger.pids.push(pid),
      flags: { allowOrigins: [...this.allowOrigins], allowApps: [...this.allowApps], sessionName: opts.session ?? this.baseSession },
    });
    await this.writeLedger();
    if (this.stopping) throw refused("ABORTED", "run was aborted while the call was in flight");
    if (r.timedOut) {
      await this.terminate("exhausted", "deadline");
      throw refused("DEADLINE", `${cmd} was killed at the deadline`, { cli: r.json });
    }
    if (r.json.ok === false && r.json.retry === "no") {
      await this.terminate("handoff", "retry_no");
      throw refused("HANDOFF", `${cmd} reported side effects that need a human (retry: no): ${String(r.json.message ?? "")}`, { cli: r.json });
    }
    return r;
  }

  private async exec(bin: ExecBin, args: string[]): Promise<ExecResult> {
    const timeoutMs = await this.callTimeout(EXEC_TIMEOUT_MS);
    const r = await this.adapter.exec(bin, args, { timeoutMs, onSpawn: (pid) => this.ledger.pids.push(pid) });
    await this.writeLedger();
    if (this.stopping) throw refused("ABORTED", "run was aborted while the call was in flight");
    return r;
  }

  private newSession(): string {
    const s = `${this.baseSession}-${++this.sessionSeq}`;
    this.ledger.sessions.push(s);
    return s;
  }

  private writeLedger() {
    return this.audit.writeJson("ledger.json", this.ledger);
  }

  private async persistBudget(): Promise<void> {
    await this.audit.writeJson("budget.json", {
      ...this.budget(), state: this.state, reason: this.reason, used: this.used, limits: this.limits, followUps: this.followUps,
      versionId: this.lastVersionId, sourceType: this.lastVersionId ? this.versions.get(this.lastVersionId)?.sourceType : undefined,
      recorded: this.recordings.size > 0, takeSeq: this.takeSeq, sessionSeq: this.sessionSeq,
    });
  }

  /** Enter a terminal state once: clean up, persist, write summary.json. */
  private async terminate(state: RunState, reason: string): Promise<void> {
    if (TERMINAL.has(this.state)) return;
    this.state = state;
    this.reason = reason;
    this.cleanupReport = await this.cleanup();
    await this.persistBudget();
    await this.audit.writeSummary({
      exitCode: this.exitCode() ?? 1, reason, durationMs: this.now() - this.startedAt,
      toolCalls: this.used.toolCalls, captures: this.used.captures, rerenders: this.used.rerenders, state, cleanup: this.cleanupReport,
    });
  }

  private async cleanup(): Promise<CleanupReport> {
    await this.adapter.killInFlight().catch(() => undefined);
    const sessionsClosed: string[] = [];
    for (const s of this.ledger.sessions) {
      const r = await this.adapter.exec("agent-browser", ["--session", s, "close"], { timeoutMs: CLEANUP_MARGIN_MS }).catch(() => undefined);
      if (r) sessionsClosed.push(s);
    }
    let pids = await this.recorderPids();
    for (let i = 0; i < 3 && pids.length; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      pids = await this.recorderPids();
    }
    let movedPartial = false;
    const out = join(this.runDir, "out");
    if (this.state !== "finished" && existsSync(out)) {
      await mkdir(join(this.runDir, "partial"), { recursive: true });
      await rename(out, join(this.runDir, "partial", `out-${this.now()}`));
      movedPartial = true;
    }
    await this.writeLedger().catch(() => undefined);
    return { sessionsClosed, openscreenRecordPids: pids, movedPartial };
  }

  private async recorderPids(): Promise<number[]> {
    const r = await this.adapter.exec("pgrep", ["-f", "openscreen record"], { timeoutMs: 10_000 }).catch(() => undefined);
    if (!r || r.code !== 0) return [];
    return r.stdout.split(/\s+/).filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n !== process.pid);
  }

  private approveCommand(hash: string): string {
    return `bun src/cli.ts approve ${this.runId} ${hash} --runs-dir ${this.runsDir}`;
  }

  /** Why the version may not be recorded yet, or undefined when a matching approval exists. */
  private async approvalProblem(v: Version): Promise<string | undefined> {
    const paths = runPaths(this.runsDir, this.runId, v.id);
    const readJson = (p: string) => readFile(p, "utf8").then((t) => JSON.parse(t) as Record<string, unknown>, () => undefined);
    const a = await readJson(paths.approval);
    if (!a) return `no approval file ${paths.approval}`;
    if (a.versionHash !== v.id) return "approval is for a different version";
    if (!sameSet(a.allowApps, [...this.allowApps])) return "approval was given for a different --allow-app set";
    if (a.bundleId !== v.bundleId) return "approval was given for a different target app";
    const run = await readJson(paths.run);
    if (!run || run.bundleId !== v.bundleId || !sameSet(run.allowApps, [...this.allowApps])) return "run.json does not match the version's app or --allow-app";
    return undefined;
  }

  private resolveBundleId(sc: Scenario): string | undefined {
    if (sc.source?.type !== "desktop") return undefined;
    const app = sc.source.app;
    const id = this.allowApps.includes(app) ? app : this.allowApps.length === 1 ? this.allowApps[0] : undefined;
    return id && !bundleRefusal(id, [...this.allowApps]) ? id : undefined;
  }

  private async addExplore(kind: ExploreEntry["kind"], target: string, snapshot: string) {
    this.explore.push({ kind, target, at: new Date(this.now()).toISOString(), snapshot });
    await this.audit.writeJson("explore.json", { entries: this.explore });
  }

  /** Warn on targets that never appeared in an explore snapshot (plan §6-1). */
  private exploreWarnings(sc: Scenario): string[] {
    const targets = (sc.steps ?? []).flatMap((s, i) => {
      if (!("target" in s)) return [];
      const key = typeof s.target === "string" ? s.target.replace(/^text=/, "").replace(/^["']|["']$/g, "") : (s.target.name ?? s.target.text ?? "");
      return key ? [{ i, key }] : [];
    });
    if (!targets.length) return [];
    if (!this.explore.length) return ["no explore snapshot recorded in this run; targets are unverified"];
    const seen = this.explore.map((e) => e.snapshot).join("\n");
    return targets.filter((t) => !seen.includes(t.key)).map((t) => `steps[${t.i}].target: "${t.key}" was not seen in any explore snapshot`);
  }

  /** Controller-side checks before the CLI: unknown keys, limits, allowlists from the launch config. */
  private async preValidate(raw: unknown): Promise<{ errors: string[]; warnings: string[]; scenario: Scenario; sourceType: SourceType; bundleId?: string }> {
    const errors: string[] = [];
    const warnings: string[] = [];
    if (!isObj(raw)) return { errors: ["scenario: must be a JSON object"], warnings, scenario: {} as Scenario, sourceType: "browser" };
    const sc = structuredClone(raw) as Record<string, unknown>;
    const strip = (o: Record<string, unknown>, path: string) => {
      for (const k of IGNORED_ALLOWLIST_KEYS) {
        if (k in o) {
          delete o[k];
          warnings.push(`${path}${k}: ignored; allowlists come only from the launch arguments`);
        }
      }
    };
    strip(sc, "");
    if (isObj(sc.source)) strip(sc.source, "source.");
    unknownKeys(sc, ["name", "source", "steps", "edit", "output"], "scenario", errors);
    // The name becomes part of a controller-generated path; check it before the CLI does.
    if (typeof sc.name !== "string" || !/^[\w.-]{1,64}$/.test(sc.name) || /^\.+$/.test(sc.name)) errors.push("name: required, [A-Za-z0-9_.-]{1,64}");
    if ("allowDestructive" in raw) errors.push("scenario.allowDestructive: not allowed in controller mode (needs user approval); acknowledge single harmless steps instead");

    const src = sc.source;
    let sourceType: SourceType = "browser";
    let bundleId: string | undefined;
    const checkUrl = (path: string, url: unknown) => {
      const n = typeof url === "string" ? normalizeOrigin(url) : undefined;
      if (!n) errors.push(`${path}: must be an http(s) URL`);
      else if (!this.allowedNorm.includes(n)) errors.push(`${path}: origin ${n} is not in --allow-origin (${this.allowOrigins.join(", ") || "none"})`);
    };
    if (!isObj(src) || !(src.type === "browser" || src.type === "desktop" || src.type === "file")) errors.push("source.type: must be browser | desktop | file");
    else {
      sourceType = src.type;
      unknownKeys(src, SOURCE_KEYS[sourceType], "source", errors);
      if (sourceType === "browser") {
        if (!this.allowOrigins.length) errors.push("source: browser runs need --allow-origin at launch");
        checkUrl("source.url", src.url);
      } else if (sourceType === "desktop") {
        if (!this.allowApps.length) errors.push("source: desktop runs need --allow-app at launch");
        bundleId = this.resolveBundleId(sc as unknown as Scenario);
        if (this.allowApps.length && !bundleId) errors.push(`source.app: must be one of --allow-app (${this.allowApps.join(", ")}) and not deny-listed`);
      } else {
        const real = typeof src.path === "string" ? await realpath(src.path).catch(() => undefined) : undefined;
        const allowed = await Promise.all(this.allowFiles.map((f) => realpath(f).catch(() => undefined)));
        if (!real || !allowed.includes(real)) errors.push("source.path: must be one of the input files named at launch");
      }
    }

    const steps = sc.steps ?? [];
    if (!Array.isArray(steps)) errors.push("steps: must be an array");
    else {
      if (steps.length > MAX_STEPS) errors.push(`steps: at most ${MAX_STEPS}`);
      steps.forEach((st, i) => {
        const p = `steps[${i}]`;
        if (!isObj(st) || typeof st.action !== "string" || !STEP_KEYS[st.action]) return errors.push(`${p}.action: must be one of ${Object.keys(STEP_KEYS).join(", ")}`);
        unknownKeys(st, ["action", "allowDestructive", ...STEP_KEYS[st.action]!], p, errors);
        if (st.waitMs !== undefined && !inRange(st.waitMs, 0, MAX_WAIT_MS)) errors.push(`${p}.waitMs: 0..${MAX_WAIT_MS}`);
        if (st.action === "wait" && !inRange(st.ms, 0, MAX_WAIT_MS)) errors.push(`${p}.ms: 0..${MAX_WAIT_MS}`);
        if (st.caption !== undefined && (typeof st.caption !== "string" || st.caption.length > MAX_CAPTION)) errors.push(`${p}.caption: at most ${MAX_CAPTION} chars`);
        if (st.action === "open") checkUrl(`${p}.url`, st.url);
        if (sourceType === "desktop" && typeof st.target === "string") errors.push(`${p}.target: string refs are not allowed; use a {role,name,text} query`);
      });
    }

    const edit = sc.edit;
    if (edit !== undefined) {
      if (!isObj(edit)) errors.push("edit: must be an object");
      else {
        unknownKeys(edit, EDIT_KEYS, "edit", errors);
        const z = edit.zoom;
        if (z !== undefined) {
          if (!isObj(z)) errors.push("edit.zoom: must be an object");
          else {
            unknownKeys(z, ["enabled", "depth", "leadMs", "holdMs", "mergeDistance"], "edit.zoom", errors);
            if (z.leadMs !== undefined && !inRange(z.leadMs, 0, 2000)) errors.push("edit.zoom.leadMs: 0..2000");
            if (z.holdMs !== undefined && !inRange(z.holdMs, 0, 4000)) errors.push("edit.zoom.holdMs: 0..4000");
          }
        }
        if (edit.captionFontSize !== undefined && !inRange(edit.captionFontSize, 16, 120)) errors.push("edit.captionFontSize: 16..120");
        if (edit.titles !== undefined) {
          const t = validateEdits({ titles: edit.titles });
          errors.push(...t.map((m) => m.replace(/^edits\./, "edit.")));
        }
      }
    }

    const out = sc.output;
    if (out !== undefined && !isObj(out)) errors.push("output: must be an object");
    else if (isObj(out)) unknownKeys(out, ["path", "quality"], "output", errors);
    sc.output = { ...(isObj(out) ? out : {}), path: "" };
    return { errors, warnings, scenario: sc as unknown as Scenario, sourceType, bundleId };
  }
}
