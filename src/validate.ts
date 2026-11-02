// Static scenario checks that run before anything is launched or recorded.

import type { Scenario, Step } from "./types.ts";

export type Issue = { path: string; level: "error" | "warning"; message: string };

// Words that suggest an irreversible or outward-facing action (R3). Matching steps are
// refused unless the scenario sets "allowDestructive": true.
const DESTRUCTIVE = /\b(delete|remove|send|submit|publish|post|purchase|buy|pay|order|transfer|unsubscribe|deactivate|erase|format)\b|削除|送信|公開|投稿|購入|支払|注文|送金|退会|消去|初期化/i;

const targetText = (s: Step): string => {
  if ("target" in s) return typeof s.target === "string" ? s.target : [s.target.role, s.target.name, s.target.text].filter(Boolean).join(" ");
  if (s.action === "press") return s.key;
  if (s.action === "open") return s.url;
  return "";
};

export type ValidateOptions = {
  /** User-supplied origins (`--allow-origin`). When set, every URL must match one by scheme+host+port. */
  allowOrigins?: string[];
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

export function validateScenario(s: unknown, opts: ValidateOptions = {}): Issue[] {
  const issues: Issue[] = [];
  const err = (path: string, message: string) => issues.push({ path, level: "error", message });
  const warn = (path: string, message: string) => issues.push({ path, level: "warning", message });
  if (!s || typeof s !== "object") return [{ path: "$", level: "error", message: "scenario must be a JSON object" }];
  const sc = s as Partial<Scenario>;

  const allowed = opts.allowOrigins?.map((o) => ({ o, n: normalizeOrigin(o) }));
  allowed?.filter((a) => !a.n).forEach((a) => err("allowOrigins", `"${a.o}" is not an http(s) origin`));
  const checkUrl = (path: string, url: unknown) => {
    const n = typeof url === "string" ? normalizeOrigin(url) : undefined;
    if (!n) return err(path, "must be an http(s) URL");
    if (allowed && !allowed.some((a) => a.n === n)) err(path, `origin ${n} is not in --allow-origin (${opts.allowOrigins!.join(", ") || "none"}); nothing was launched`);
  };

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
    steps.forEach((st, i) => {
      const p = `steps[${i}]`;
      const known = ["click", "fill", "press", "scroll", "open", "wait", "mark"];
      if (!known.includes(st?.action)) return err(`${p}.action`, `must be one of ${known.join(", ")}`);
      if ((st.action === "click" || st.action === "fill") && !st.target) err(`${p}.target`, "required");
      if (st.action === "fill" && typeof st.value !== "string") err(`${p}.value`, "required string");
      if (src?.type === "desktop" && (st.action === "scroll" || st.action === "open")) err(`${p}.action`, `${st.action} is browser-only`);
      if (st.action === "open") checkUrl(`${p}.url`, st.url);
      if (src?.type === "browser" && "target" in st && typeof st.target !== "string") err(`${p}.target`, "browser targets are selector strings");
      if (src?.type === "browser" && "target" in st && typeof st.target === "string" && /^@e\d+$/.test(st.target))
        err(`${p}.target`, "snapshot refs (@eN) do not survive into the recording session; use a CSS/text selector");
      if (DESTRUCTIVE.test(targetText(st)) && !sc.allowDestructive && !st.allowDestructive)
        err(`${p}`, `looks irreversible ("${targetText(st)}"). Remove it, or after confirming it is harmless set "allowDestructive": true on this step (or on the scenario for real destructive demos, with user approval)`);
      if ("caption" in st && st.caption && st.caption.length > 40) warn(`${p}.caption`, "longer than 40 chars; it may wrap or overflow");
    });
  }
  const e = sc.edit;
  if (e?.zoom?.depth !== undefined && ![1, 2, 3, 4, 5, 6].includes(e.zoom.depth)) err("edit.zoom.depth", "must be 1..6");
  if (e?.speechCaptions && src?.type === "browser") warn("edit.speechCaptions", "browser capture has no audio; captions will be skipped");
  return issues;
}

const EVENT_KINDS = ["click", "type", "press", "scroll", "navigate", "wait", "mark"];
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
    if (e.point !== undefined) {
      if (!(num(e.point?.cx) && num(e.point?.cy))) err(`${p}.point`, "must be {cx, cy}");
      else if (!in01(e.point.cx) || !in01(e.point.cy)) err(`${p}.point`, "cx and cy must be fractions of the frame (0..1), not pixels");
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
