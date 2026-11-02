// Static scenario checks that run before anything is launched or recorded.

import type { Composition, CompositionEdit, Scenario, Source, Step, Target } from "./types.ts";

export type Issue = { path: string; level: "error" | "warning"; message: string };

// Words that suggest an irreversible or outward-facing action (R3). Matching steps are
// refused unless the scenario sets "allowDestructive": true.
const DESTRUCTIVE = /\b(delete|remove|send|submit|publish|post|purchase|buy|pay|order|transfer|unsubscribe|deactivate|erase|format)\b|削除|送信|公開|投稿|購入|支払|注文|送金|退会|消去|初期化/i;

/** Does this text read like an irreversible or outward-facing action? A word-list guess only. */
export const looksDestructive = (text: string) => DESTRUCTIVE.test(text);

const queryText = (t: Target) => (typeof t === "string" ? t : [t.role, t.name, t.text].filter(Boolean).join(" "));
const targetText = (s: Step): string => {
  if ("target" in s && s.target) {
    const t = queryText(s.target);
    if (s.action === "drag" && s.to) return `${t} ${queryText(s.to)}`; // the drop target is the action ("Trash")
    return s.action === "select" ? `${t} ${s.value}` : t; // the chosen option is the action ("Delete account")
  }
  if (s.action === "press") return s.key;
  if (s.action === "open") return s.url;
  return "";
};

export type ValidateOptions = {
  /** User-supplied origins (`--allow-origin`). When set, every URL must match one by scheme+host+port. */
  allowOrigins?: string[];
  /** Inside a `session`: refs from `session observe` (browser `@eN`) are valid, because the same
   * browser session that produced them performs the step. */
  liveRefs?: boolean;
};

const DEFAULT_PORT: Record<string, string> = { "http:": "80", "https:": "443" };

/** `scheme://host:port` with the default port made explicit, or undefined if not an http(s) URL. */
export function normalizeOrigin(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  const def = DEFAULT_PORT[u.protocol];
  if (!def || !u.hostname) return undefined;
  return `${u.protocol}//${u.hostname}:${u.port || def}`;
}

/** Hosts for agent-browser `--allowed-domains` (it matches by domain, not port). */
export function allowedDomains(origins: string[]): string {
  return [...new Set(origins.map((o) => new URL(o).hostname))].join(",");
}

type ErrFn = (path: string, message: string) => void;

/** Checks a URL against `--allow-origin`; reports through `err`. */
function urlChecker(opts: ValidateOptions, err: ErrFn, reportBadOrigins = true) {
  const allowed = opts.allowOrigins?.map((o) => ({ o, n: normalizeOrigin(o) }));
  if (reportBadOrigins) allowed?.filter((a) => !a.n).forEach((a) => err("allowOrigins", `"${a.o}" is not an http(s) origin`));
  return (path: string, url: unknown) => {
    const n = typeof url === "string" ? normalizeOrigin(url) : undefined;
    if (!n) return err(path, "must be an http(s) URL");
    if (opts.allowOrigins && !allowed!.some((a) => a.n === n)) err(path, `origin ${n} is not in --allow-origin (${opts.allowOrigins.join(", ") || "none"}); nothing was launched`);
  };
}

const STEP_ACTIONS = ["click", "fill", "select", "hover", "drag", "press", "scroll", "open", "wait", "mark"];
const SCROLL_DIRECTIONS = ["up", "down", "left", "right"];
/** agent-browser resolves all of these as snapshot refs (verified on 0.41.1): "@e3", "ref=e3", "e3". */
const BROWSER_REF = /^(?:@|ref=)?e(\d+)$/;
/** The canonical "@eN" key for a browser ref, or undefined if the string is a selector. */
export function browserRefKey(target: string): string | undefined {
  const m = BROWSER_REF.exec(target.trim()); // agent-browser trims, so " @e3" is a ref too
  return m ? `@e${m[1]}` : undefined;
}

/** A session step as it will be checked AND executed: string targets trimmed, browser refs spelled "@eN".
 * Checking one string and running another is how a ref slips past the guards. */
export function normalizeSessionStep(raw: unknown, src: Partial<Source> | undefined): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const st = { ...(raw as Record<string, unknown>) };
  for (const k of ["target", "to"]) {
    const v = st[k];
    if (typeof v !== "string") continue;
    const t = v.trim();
    st[k] = src?.type === "browser" ? (browserRefKey(t) ?? t) : t;
  }
  return st;
}
export const SESSION_MAX_WAIT_MS = 60_000;

/** One step, as a scenario's `steps[i]` or a `session act` step. `allowDestructive` is the scenario-level approval. */
export function validateStep(raw: unknown, src: Partial<Source> | undefined, opts: ValidateOptions = {}, allowDestructive = false, p = "step"): Issue[] {
  const issues: Issue[] = [];
  const err: ErrFn = (path, message) => issues.push({ path, level: "error", message });
  const warn: ErrFn = (path, message) => issues.push({ path, level: "warning", message });
  const st = raw as Step;
  if (!st || typeof st !== "object") return [{ path: p, level: "error", message: "must be a step object" }];
  if (!STEP_ACTIONS.includes(st.action)) {
    err(`${p}.action`, `must be one of ${STEP_ACTIONS.join(", ")}`);
    return issues;
  }
  const urlCheck = urlChecker(opts, err, false);
  if ((st.action === "click" || st.action === "fill" || st.action === "select" || st.action === "hover" || st.action === "drag") && !st.target) err(`${p}.target`, "required");
  if (st.action === "drag" && !st.to) err(`${p}.to`, "required");
  if ((st.action === "hover" || st.action === "drag") && src?.type === "desktop" && (src as { physicalInput?: unknown }).physicalInput !== true)
    err(`${p}.action`, `desktop ${st.action} moves the real pointer (agent-desktop --headed); set "physicalInput": true on the source after the user agrees`);
  if ((st.action === "fill" || st.action === "select") && typeof st.value !== "string") err(`${p}.value`, "required string");
  if (st.action === "press" && (typeof st.key !== "string" || !st.key)) err(`${p}.key`, "required string");
  if (st.action === "wait" && !(num(st.ms) && st.ms >= 0)) err(`${p}.ms`, "required number >= 0");
  // A session serializes requests; an unbounded wait would hold the recorder (and stop) hostage.
  else if (st.action === "wait" && opts.liveRefs && st.ms > SESSION_MAX_WAIT_MS) err(`${p}.ms`, `at most ${SESSION_MAX_WAIT_MS} in a session; send several waits`);
  if (st.action === "mark" && typeof st.caption !== "string") err(`${p}.caption`, "required string");
  if ("waitMs" in st && st.waitMs !== undefined) {
    if (!(num(st.waitMs) && st.waitMs >= 0)) err(`${p}.waitMs`, "must be a number >= 0");
    else if (opts.liveRefs && st.waitMs > SESSION_MAX_WAIT_MS) err(`${p}.waitMs`, `at most ${SESSION_MAX_WAIT_MS} in a session`);
  }
  if (st.action === "scroll") {
    if (st.direction !== undefined && !SCROLL_DIRECTIONS.includes(st.direction)) err(`${p}.direction`, `must be one of ${SCROLL_DIRECTIONS.join(", ")}`);
    if (st.px !== undefined && !(num(st.px) && st.px > 0)) err(`${p}.px`, "must be a number > 0");
    if (src?.type === "desktop" && !st.target) err(`${p}.target`, "desktop scroll needs the element to scroll (a find query or a session ref)");
    if (src?.type === "browser" && st.target !== undefined) err(`${p}.target`, "browser scroll scrolls the page; omit target");
  }
  if (src?.type === "desktop" && st.action === "open") err(`${p}.action`, "open is browser-only");
  if (st.action === "open") urlCheck(`${p}.url`, st.url);
  for (const k of ["target", "to"] as const) {
    const t = (st as Record<string, unknown>)[k];
    if (src?.type === "browser" && t !== undefined && typeof t !== "string") err(`${p}.${k}`, "browser targets are selector strings");
    if (src?.type === "desktop" && !opts.liveRefs && typeof t === "string")
      err(`${p}.${k}`, "desktop targets are find queries ({role, name, text, exact}); ref strings are valid only in `session act`, from `session observe`");
    if (src?.type === "browser" && !opts.liveRefs && typeof t === "string" && browserRefKey(t))
      err(`${p}.${k}`, "snapshot refs (@eN) do not survive into the recording session; use a CSS/text selector (refs are valid only in `session act`)");
  }
  if (DESTRUCTIVE.test(targetText(st)) && !allowDestructive && !st.allowDestructive)
    err(`${p}`, `looks irreversible ("${targetText(st)}"). Remove it, or after confirming it is harmless set "allowDestructive": true on this step (or on the scenario for real destructive demos, with user approval)`);
  if ("caption" in st && st.caption && st.caption.length > 40) warn(`${p}.caption`, "longer than 40 chars; it may wrap or overflow");
  return issues;
}

export function validateScenario(s: unknown, opts: ValidateOptions = {}): Issue[] {
  const issues: Issue[] = [];
  const err = (path: string, message: string) => issues.push({ path, level: "error", message });
  const warn = (path: string, message: string) => issues.push({ path, level: "warning", message });
  if (!s || typeof s !== "object") return [{ path: "$", level: "error", message: "scenario must be a JSON object" }];
  const sc = s as Partial<Scenario>;

  const checkUrl = urlChecker(opts, err);
  if (!sc.name || !/^[\w.-]+$/.test(sc.name)) err("name", "required, [A-Za-z0-9_.-]+");
  if (!sc.output?.path) err("output.path", "required (.mp4 or .gif)");
  else if (!/\.(mp4|gif)$/i.test(sc.output.path)) err("output.path", "must end with .mp4 or .gif");

  const src = sc.source;
  if (!src || typeof src !== "object") err("source", "required");
  else if (src.type === "browser") {
    checkUrl("source.url", src.url);
  } else if (src.type === "desktop") {
    if (!src.app) err("source.app", "required");
    warn("source", "desktop capture records the real window, including notifications that appear over it");
  } else if (src.type === "file") {
    if (!src.path) err("source.path", "required");
  } else err("source.type", "must be browser | desktop | file");

  const steps = sc.steps ?? [];
  if (!Array.isArray(steps)) err("steps", "must be an array");
  else {
    if (src?.type === "file" && steps.length) err("steps", "file sources cannot run steps");
    steps.forEach((st, i) => issues.push(...validateStep(st, src, opts, sc.allowDestructive === true, `steps[${i}]`)));
  }
  const e = sc.edit;
  if (e?.zoom?.depth !== undefined && ![1, 2, 3, 4, 5, 6].includes(e.zoom.depth)) err("edit.zoom.depth", "must be 1..6");
  if (e?.speechCaptions && src?.type === "browser") warn("edit.speechCaptions", "browser capture has no audio; captions will be skipped");
  return issues;
}

const EVENT_KINDS = ["click", "type", "hover", "drag", "press", "scroll", "navigate", "wait", "mark"];
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const in01 = (v: unknown): boolean => num(v) && v >= 0 && v <= 1;

/** Shape of an ActionEvent[] file (a file source's `events`, or a project's events.json).
 * Points drive zooms and the synthetic cursor, so a wrong shape or a pixel coordinate is an
 * error. Rects only drive redaction and may legitimately hang off the frame, so out-of-range
 * rects are warnings. */
export function validateEvents(raw: unknown, at = "events"): Issue[] {
  const issues: Issue[] = [];
  const err = (path: string, message: string) => issues.push({ path, level: "error", message });
  const warn = (path: string, message: string) => issues.push({ path, level: "warning", message });
  if (!Array.isArray(raw)) return [{ path: at, level: "error", message: "must be an array of ActionEvent" }];
  raw.forEach((e, i) => {
    const p = `${at}[${i}]`;
    if (!e || typeof e !== "object") return err(p, "must be an object");
    if (!num(e.tMs) || e.tMs < 0) err(`${p}.tMs`, "must be a number >= 0 (ms on the video timeline)");
    if (!EVENT_KINDS.includes(e.kind)) err(`${p}.kind`, `must be one of ${EVENT_KINDS.join(", ")}`);
    for (const k of ["point", "to"] as const) {
      if (e[k] === undefined) continue;
      if (!(num(e[k]?.cx) && num(e[k]?.cy))) err(`${p}.${k}`, "must be {cx, cy}");
      else if (!in01(e[k].cx) || !in01(e[k].cy)) err(`${p}.${k}`, "cx and cy must be fractions of the frame (0..1), not pixels");
    }
    if (e.rect !== undefined) {
      if (!["x", "y", "w", "h"].every((k) => num(e.rect?.[k]))) err(`${p}.rect`, "must be {x, y, w, h}");
      else if (!in01(e.rect.x) || !in01(e.rect.y) || !in01(e.rect.w) || !in01(e.rect.h) || e.rect.x + e.rect.w > 1 + 1e-9 || e.rect.y + e.rect.h > 1 + 1e-9)
        warn(`${p}.rect`, "extends outside the frame (values are fractions 0..1); the redaction box may be clipped or misplaced");
    }
    if (e.caption !== undefined && typeof e.caption !== "string") err(`${p}.caption`, "must be a string");
    for (const k of ["zoom", "redact"] as const) if (e[k] !== undefined && typeof e[k] !== "boolean") err(`${p}.${k}`, "must be true or false");
    if (e.redact === true && e.rect === undefined) warn(`${p}.redact`, "has no effect without rect");
  });
  return issues;
}

/** A composition is any object with a `scenes` array; everything else is treated as a scenario. */
export const isComposition = (raw: unknown): boolean => Array.isArray((raw as { scenes?: unknown } | null)?.scenes);

const COMPOSITION_EDIT_KEYS: (keyof CompositionEdit)[] = ["zoom", "syntheticCursor", "stepCaptions", "captionFontSize", "titleFontSize", "titles", "style"];
const STREAMS_PER_LAYOUT: Record<string, number> = { single: 1, "side-by-side": 2 };

/** `scenarioNames[i]` is the name read from `scenarios[i]` (undefined if it could not be read). */
export function validateComposition(raw: unknown, scenarioNames: (string | undefined)[]): Issue[] {
  const issues: Issue[] = [];
  const err = (path: string, message: string) => issues.push({ path, level: "error", message });
  if (!raw || typeof raw !== "object") return [{ path: "$", level: "error", message: "composition must be a JSON object" }];
  const c = raw as Partial<Composition>;

  if (!c.name || !/^[\w.-]+$/.test(c.name)) err("name", "required, [A-Za-z0-9_.-]+");
  if (!c.output?.path) err("output.path", "required (.mp4 or .gif)");
  else if (!/\.(mp4|gif)$/i.test(c.output.path)) err("output.path", "must end with .mp4 or .gif");

  if (!Array.isArray(c.scenarios) || c.scenarios.length < 1 || c.scenarios.length > 2) err("scenarios", "must list 1 or 2 scenario JSON paths");
  else
    c.scenarios.forEach((p, i) => {
      if (typeof p !== "string" || !p) return err(`scenarios[${i}]`, "must be a scenario JSON path");
      if (c.scenarios!.indexOf(p) < i) err(`scenarios[${i}]`, `duplicate path "${p}"`);
      const n = scenarioNames[i];
      if (!n) err(`scenarios[${i}]`, "the referenced scenario has no name (or could not be read)");
      else if (scenarioNames.indexOf(n) < i) err(`scenarios[${i}]`, `scenario name "${n}" is used by scenarios[${scenarioNames.indexOf(n)}] too; names must be unique`);
    });

  const known = new Set(scenarioNames.filter(Boolean));
  if (!Array.isArray(c.scenes) || c.scenes.length === 0) err("scenes", "must be a non-empty array");
  else
    c.scenes.forEach((sc, i) => {
      const p = `scenes[${i}]`;
      const want = STREAMS_PER_LAYOUT[sc?.layout as string];
      if (!want) return err(`${p}.layout`, "must be single | side-by-side");
      if (!Array.isArray(sc.streams) || sc.streams.length !== want) return err(`${p}.streams`, `${sc.layout} needs exactly ${want} stream${want > 1 ? "s" : ""}`);
      sc.streams.forEach((st, j) => {
        const q = `${p}.streams[${j}]`;
        if (typeof st?.scenario !== "string" || !known.has(st.scenario)) err(`${q}.scenario`, `must be the name of a listed scenario (${[...known].join(", ") || "none"})`);
        for (const k of ["startMs", "endMs"] as const) if (st?.[k] !== undefined && !(num(st[k]) && st[k] >= 0)) err(`${q}.${k}`, "must be a number >= 0");
        if (num(st?.startMs) && num(st?.endMs) && st.startMs >= st.endMs) err(q, "startMs must be less than endMs");
      });
    });

  if (c.size !== undefined) {
    const [w, h] = Array.isArray(c.size) ? c.size : [];
    if (!Array.isArray(c.size) || c.size.length !== 2 || !Number.isInteger(w) || !Number.isInteger(h) || w! <= 0 || h! <= 0) err("size", "must be [width, height] in positive integers");
    else if (w! % 4 || h! % 2) err("size", "width must be a multiple of 4 and height a multiple of 2");
  }
  if (c.edit !== undefined) {
    if (!c.edit || typeof c.edit !== "object") err("edit", "must be an object");
    else
      for (const k of Object.keys(c.edit))
        if (!COMPOSITION_EDIT_KEYS.includes(k as keyof CompositionEdit)) err(`edit.${k}`, `not supported in a composition (allowed: ${COMPOSITION_EDIT_KEYS.join(", ")})`);
  }
  return issues;
}
