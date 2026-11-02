export type Stage = "validate" | "doctor" | "capture" | "compile" | "render" | "inspect";

/** Whether the caller may simply run the same command again.
 * - safe: nothing external happened; rerun as is.
 * - after-fix: rerun only after changing the input named in `hint`.
 * - no: side effects may have happened (app state changed, file written); inspect first. */
export type Retry = "safe" | "after-fix" | "no";

export class ToolError extends Error {
  constructor(
    public stage: Stage,
    public code: string,
    message: string,
    public retry: Retry,
    public hint?: string,
    public artifacts?: Record<string, string>,
  ) {
    super(message);
  }
  toJSON() {
    return { ok: false, stage: this.stage, code: this.code, message: this.message, retry: this.retry, hint: this.hint, artifacts: this.artifacts };
  }
}

export function asToolError(e: unknown, stage: Stage, artifacts?: Record<string, string>): ToolError {
  if (e instanceof ToolError) {
    if (artifacts) e.artifacts = { ...artifacts, ...e.artifacts };
    return e;
  }
  const message = e instanceof Error ? e.message : String(e);
  if (stage === "capture" && /Element not found|no element for|STALE_REF|AMBIGUOUS_TARGET/.test(message)) {
    return new ToolError(stage, "TARGET_NOT_FOUND", message, "no",
      "earlier steps already ran in the app; reset its state, re-explore the UI at that step (snapshot), fix the target, then capture --force", artifacts);
  }
  if (stage === "capture" && message.startsWith("APP_NOT_ALLOWED:")) {
    return new ToolError(stage, "APP_NOT_ALLOWED", message, "no", "the target window is not an allowed app; check --allow-app and the window the scenario resolves to", artifacts);
  }
  // Capture failures can leave the app half-operated: never mark them safe.
  const retry: Retry = stage === "capture" ? "no" : "after-fix";
  return new ToolError(stage, "UNEXPECTED", message, retry, undefined, artifacts);
}
