// Shared types. Times are milliseconds on the video timeline; points/rects are
// normalized to the captured frame (0..1).

export type NPoint = { cx: number; cy: number };
export type NRect = { x: number; y: number; w: number; h: number };

/** One thing the agent did while recording, mapped onto the video timeline. */
export type ActionEvent = {
  tMs: number;
  kind: "click" | "type" | "hover" | "drag" | "press" | "scroll" | "navigate" | "wait" | "mark";
  label?: string;
  caption?: string;
  rect?: NRect;
  point?: NPoint;
  /** drag only: where the pointer is released. */
  to?: NPoint;
  zoom?: boolean;
  redact?: boolean;
};

export type CaptureResult = {
  videoPath: string;
  width: number;
  height: number;
  durationMs: number;
  events: ActionEvent[];
  /** Real pointer telemetry exists (only true for human-driven OpenScreen recordings). */
  realCursor: boolean;
  /** Wall-clock time of video t=0; aligns parallel captures. */
  t0EpochMs?: number;
  /** Set by a composition run; captures from different runs are joined without time alignment. */
  runId?: string;
};

// ---- Scenario (what an LLM agent writes) ----

export type BrowserSource = {
  type: "browser";
  url: string;
  viewport?: [number, number];
  headed?: boolean;
};
export type DesktopSource = {
  type: "desktop";
  app: string;
  /** Window title substring passed to `openscreen record --window`. Defaults to app. */
  window?: string;
  launch?: boolean;
  systemAudio?: boolean;
  /** Allow hover/drag, which agent-desktop can only deliver with the real pointer (`--headed`):
   * the user's mouse is taken over during those steps. Confirm with the user first. */
  physicalInput?: boolean;
};
export type FileSource = {
  type: "file";
  path: string;
  /** Optional ActionEvent[] JSON with normalized coordinates (e.g. from a previous run). */
  events?: string;
};
export type Source = BrowserSource | DesktopSource | FileSource;

/** Browser targets use agent-browser selectors (`text=..`, css; `@eN` only inside a `session`,
 * where the ref comes from `session observe`). Desktop targets use an agent-desktop `find`
 * query, or inside a `session` a qualified ref string (`@<snapshot_id>:eN`) from `session observe`. */
export type DesktopTarget = { role?: string; name?: string; text?: string; exact?: boolean };
export type Target = string | DesktopTarget;

/** Per-step acknowledgement for a step the destructive-word guard flags but the agent has
 * confirmed is harmless (e.g. a calculator's "すべて消去"). Narrower than scenario.allowDestructive. */
export type StepAck = { allowDestructive?: boolean };

export type Step = StepAck & (
  | { action: "click"; target: Target; caption?: string; zoom?: boolean; redact?: boolean; waitMs?: number }
  | { action: "fill"; target: Target; value: string; caption?: string; zoom?: boolean; redact?: boolean; waitMs?: number }
  /** Move the pointer onto the target without clicking (menus, tooltips). Desktop needs source.physicalInput. */
  | { action: "hover"; target: Target; caption?: string; zoom?: boolean; waitMs?: number }
  /** Press on target, move to `to`, release. Desktop needs source.physicalInput. */
  | { action: "drag"; target: Target; to: Target; caption?: string; zoom?: boolean; waitMs?: number }
  | { action: "press"; key: string; caption?: string; waitMs?: number }
  /** Browser: scrolls the page by px (no target). Desktop: scrolls the target element by
   * max(1, round(px / 100)) scroll units (px defaults to 300). */
  | { action: "scroll"; target?: Target; direction?: "up" | "down" | "left" | "right"; px?: number; caption?: string; waitMs?: number }
  /** Pick an option in a dropdown / list (browser: by value or visible label). */
  | { action: "select"; target: Target; value: string; caption?: string; zoom?: boolean; redact?: boolean; waitMs?: number }
  | { action: "open"; url: string; caption?: string; waitMs?: number }
  | { action: "wait"; ms: number; caption?: string }
  | { action: "mark"; caption: string; waitMs?: number }
);

export type EditPlan = {
  zoom?: { enabled?: boolean; depth?: 1 | 2 | 3 | 4 | 5 | 6; leadMs?: number; holdMs?: number; mergeDistance?: number };
  /** Generate an animated cursor from the action log (headless runs have no real pointer). */
  syntheticCursor?: boolean;
  /** Captions from step.caption, rendered as text annotations. */
  stepCaptions?: boolean;
  captionFontSize?: number;
  titleFontSize?: number;
  /** Whisper captions from recorded audio (needs audio in the recording). */
  speechCaptions?: boolean;
  /** Speed up gaps with no actions longer than this (ms). 0 disables. */
  idleSpeedupMs?: number;
  idleSpeed?: number;
  titles?: { text: string; startMs: number; endMs: number }[];
  redact?: { rect: NRect; startMs: number; endMs: number }[];
  trim?: { startMs: number; endMs: number }[];
  /** Raw overrides merged into project.editor (padding, wallpaper, borderRadius, ...). */
  style?: Record<string, unknown>;
};

export type Output = {
  path: string;
  quality?: "medium" | "good" | "source";
  gifFps?: 15 | 20 | 25 | 30;
  gifSize?: "medium" | "large" | "original";
  audio?: string;
  audioMode?: "mix" | "replace";
};

export type Scenario = {
  name: string;
  /** Required to run steps that look irreversible (delete, send, purchase, ...). Confirm with the user first. */
  allowDestructive?: boolean;
  source: Source;
  steps?: Step[];
  edit?: EditPlan;
  output: Output;
};

// ---- Composition (several scenarios recorded together, joined into one video) ----

/** Edit keys that make sense across streams; trim/idle speed-ups/speech/plan-level redact would break inspect's time mapping. */
export type CompositionEdit = Pick<EditPlan, "zoom" | "syntheticCursor" | "stepCaptions" | "captionFontSize" | "titleFontSize" | "titles" | "style">;
/** startMs/endMs are on the aligned timeline (after leading offsets are removed). */
export type SceneStream = { scenario: string; startMs?: number; endMs?: number };
/** single: 1 stream; side-by-side: 2 (left, right). */
export type Scene = { layout: "single" | "side-by-side"; streams: SceneStream[] };
export type Composition = {
  name: string;
  /** Scenario JSON paths, relative to the current directory. */
  scenarios: string[];
  scenes: Scene[];
  size?: [number, number];
  edit?: CompositionEdit;
  output: Output;
};
