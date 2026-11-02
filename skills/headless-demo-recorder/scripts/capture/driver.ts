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

/** Run steps through a driver; on a failed step, stop the recorder and rethrow (scenario runs are all-or-nothing). */
export async function runSteps(d: Driver, steps: Step[]): Promise<CaptureResult> {
  try {
    for (const step of steps) await d.act(step);
  } catch (e) {
    await d.close();
    throw e;
  }
  return d.finish();
}

export const stepWaitMs = (step: Step, fallback: number) => ("waitMs" in step && step.waitMs !== undefined ? step.waitMs : fallback);
