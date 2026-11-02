import { log } from "../exec.ts";
import type { ActionEvent, CaptureResult, Step } from "../types.ts";

/** A recording in progress. `captureBrowser`/`captureDesktop` run a scenario's steps through it;
 * a `session` drives it one step at a time while an agent observes the screen between steps. */
export type Driver = {
  /** Perform one step and log it. On failure the step's event is dropped and the recording continues. */
  act(step: Step): Promise<ActionEvent | undefined>;
  /** The current UI as the agent sees it: an accessibility snapshot with refs usable in `act`,
   * plus a PNG when `screenshot` (a path) is given. */
  observe(opts?: { screenshot?: string }): Promise<Record<string, unknown>>;
  /** What a ref string from the latest `observe` points at ("button Delete account"), or
   * undefined when the ref did not come from it. A session refuses refs it cannot name. */
  refLabel(ref: string): string | undefined;
  /** False once the recorder has exited on its own (the window closed, a crash). */
  alive(): boolean;
  /** Milliseconds since video t=0. */
  elapsedMs(): number;
  eventCount(): number;
  /** Stop recording and release the browser/recorder. Idempotent; never throws. */
  close(): Promise<void>;
  /** close() and convert the recording into `<workDir>/capture.mp4`. */
  finish(): Promise<CaptureResult>;
};

const clip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** One step for the progress log. Never includes a fill value: it may be a password. */
export function describeStep(step: Step): string {
  const target = "target" in step && step.target !== undefined ? (typeof step.target === "string" ? step.target : JSON.stringify(step.target)) : undefined;
  const what = step.action === "press" ? step.key : step.action === "open" ? step.url : step.action === "wait" ? `${step.ms}ms` : target;
  const caption = "caption" in step && step.caption ? ` "${clip(step.caption, 40)}"` : "";
  return `${step.action}${what ? ` ${clip(what)}` : ""}${caption}`;
}

/** Progress on stderr while recording: which step, how far into the video, how long it took. */
export async function actLogged(d: Driver, step: Step, label: string): Promise<ActionEvent | undefined> {
  const at = d.elapsedMs();
  log(`${label} ${describeStep(step)} @ ${(at / 1000).toFixed(1)}s`);
  try {
    return await d.act(step);
  } catch (e) {
    // Tool errors put the command line first and the reason ("✗ Element not found ...") after it.
    const lines = (e as Error).message.split("\n").map((l) => l.trim()).filter(Boolean);
    log(`${label} failed after ${((d.elapsedMs() - at) / 1000).toFixed(1)}s: ${lines.find((l) => l.startsWith("✗")) ?? lines[0] ?? "unknown error"}`);
    throw e;
  }
}

/** Run steps through a driver; on a failed step, stop the recorder and rethrow (scenario runs are all-or-nothing). */
export async function runSteps(d: Driver, steps: Step[]): Promise<CaptureResult> {
  try {
    for (const [i, step] of steps.entries()) await actLogged(d, step, `step ${i + 1}/${steps.length}`);
  } catch (e) {
    await d.close();
    throw e;
  }
  log(`all ${steps.length} steps done @ ${(d.elapsedMs() / 1000).toFixed(1)}s; stopping the recording`);
  return d.finish();
}

export const stepWaitMs = (step: Step, fallback: number) => ("waitMs" in step && step.waitMs !== undefined ? step.waitMs : fallback);
