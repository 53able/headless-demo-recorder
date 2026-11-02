// Shared types for the pi-independent controller (no @earendil-works/* imports here).

export type RunState =
  | "ready" | "checked" | "approved" | "recorded" | "rendered" | "inspected"
  | "finished" | "handoff" | "exhausted" | "failed";

export const TERMINAL: ReadonlySet<RunState> = new Set(["finished", "handoff", "exhausted", "failed"]);

export const EXIT_CODES: Partial<Record<RunState, number>> = { finished: 0, failed: 1, handoff: 3, exhausted: 4 };

export type Budgets = { captures: number; rerenders: number; toolCalls: number; deadlineMs: number };

export const DEFAULT_BUDGETS: Budgets = { captures: 2, rerenders: 3, toolCalls: 40, deadlineMs: 900_000 };

export type Counter = { used: number; max: number };

export type BudgetSnapshot = {
  captures: Counter;
  rerenders: Counter;
  toolCalls: Counter;
  renders: number;
  deadlineMs: number;
  elapsedMs: number;
};

/** Flags the controller adds to every CLI call. Never taken from the scenario. */
export type ControllerFlags = { allowOrigins: string[]; allowApps: string[]; sessionName: string };

export type CliCommand = "doctor" | "check" | "capture" | "render" | "inspect";

export type CliCall = {
  cmd: CliCommand;
  /** Positional arguments and command options, as a fixed array (never a shell string). */
  args: string[];
  flags: ControllerFlags;
  timeoutMs: number;
  onSpawn?: (pid: number) => void;
};

/** The single stdout JSON of `src/cli.ts`. `ok:false` carries stage, code, retry, hint. */
export type CliJson = { ok?: boolean; retry?: "safe" | "after-fix" | "no"; code?: string; message?: string; [k: string]: unknown };

export type CliResult = { exitCode: number | null; json: CliJson; timedOut: boolean; pid?: number };

export type ExecBin = "agent-browser" | "agent-desktop" | "pgrep";

export type ExecResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean; pid?: number };

export interface Adapter {
  cli(call: CliCall): Promise<CliResult>;
  exec(bin: ExecBin, args: string[], opts: { timeoutMs: number; onSpawn?: (pid: number) => void }): Promise<ExecResult>;
  /** SIGTERM every in-flight child, SIGKILL after the grace period; resolves when all are gone. */
  killInFlight(): Promise<void>;
}

export type TriState = boolean | "not_applicable";

export type Tile = {
  index: number;
  acted_element_visible: TriState;
  cursor_on_target: TriState;
  caption_readable: TriState;
  privacy_issue: TriState;
  /** Required when any field is "not_applicable". */
  reason?: string;
  note?: string;
};

export type RenderEdits = {
  captions?: { eventIndex: number; text: string }[];
  timeShift?: { eventIndex: number; deltaMs: number }[];
  zoom?: { depth?: number; leadMs?: number; holdMs?: number };
  captionFontSize?: number;
  titles?: { text: string; startMs: number; endMs: number }[];
};
