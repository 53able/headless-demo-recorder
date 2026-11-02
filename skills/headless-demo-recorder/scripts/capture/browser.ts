import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { childEnv, ffprobe, log, run, runOk, sleep, toMp4 } from "../exec.ts";
import { centerOf } from "../compile.ts";
import type { ActionEvent, BrowserSource, CaptureResult, NRect, Step } from "../types.ts";
import { runSteps, stepWaitMs, type Driver } from "./driver.ts";
import { allowedDomains } from "../validate.ts";

export type BrowserOptions = {
  /** User-supplied origins; passed to agent-browser as `--allowed-domains` (host only). */
  allowOrigins?: string[];
  /** agent-browser session name chosen by the caller, so it can close the session itself. */
  sessionName?: string;
  /** Awaited after recording starts, before any scenario steps. */
  ready?: () => Promise<void>;
};

type Box = { x: number; y: number; width: number; height: number };

/** Open the page and start recording WebM; the returned driver performs steps and logs element boxes. */
export async function startBrowser(src: BrowserSource, workDir: string, opts: BrowserOptions = {}): Promise<Driver> {
  const [vw, vh] = src.viewport ?? [1280, 720];
  const session = opts.sessionName ?? `headless-demo-recorder-${process.pid}-${Date.now()}`;
  if (!opts.allowOrigins?.length) log("warning: no --allow-origin given; the browser may reach any host");
  // Every invocation carries the same restriction, including record stop/close.
  // ponytail: works around an agent-browser bug (see ws-constants.js); drop once fixed upstream.
  const base = ["--session", session, ...(opts.allowOrigins?.length
    ? ["--allowed-domains", allowedDomains(opts.allowOrigins), "--init-script", fileURLToPath(new URL("./ws-constants.js", import.meta.url))]
    : [])];
  const env = childEnv();
  const ab = (...args: string[]) => runOk("agent-browser", [...base, ...(src.headed ? ["--headed"] : []), ...args], { timeoutMs: 60_000, env });
  const abJson = async <T>(...args: string[]): Promise<T> => {
    const out = await ab("--json", ...args);
    const j = JSON.parse(out) as { success: boolean; data: T; error: unknown };
    if (!j.success) throw new Error(`agent-browser ${args.join(" ")}: ${JSON.stringify(j.error)}`);
    return j.data;
  };

  const webm = join(workDir, "browser.webm");
  const events: ActionEvent[] = [];
  let t0 = 0;
  let wallMs = 0;
  const now = () => Date.now() - t0;

  const boxOf = async (sel: string): Promise<NRect | undefined> => {
    try {
      await ab("scrollintoview", sel);
      const b = await abJson<Box>("get", "box", sel);
      const r = { x: b.x / vw, y: b.y / vh, w: b.width / vw, h: b.height / vh };
      // Element still outside the viewport: no usable focus point.
      if (r.y > 1 || r.y + r.h < 0 || r.x > 1 || r.x + r.w < 0) return undefined;
      return r;
    } catch (e) {
      log(`box lookup failed for ${sel}: ${(e as Error).message.split("\n")[0]}`);
      return undefined;
    }
  };

  let closing: Promise<void> | undefined;
  const close = () => (closing ??= (async () => {
    wallMs = t0 ? Date.now() - t0 : 0;
    if (t0) await run("agent-browser", [...base, "record", "stop"], { timeoutMs: 60_000, env, cleanup: true }).catch((e: Error) => log(`record stop failed: ${e.message}`));
    await run("agent-browser", [...base, "close"], { timeoutMs: 30_000, env, cleanup: true }).catch((e: Error) => log(`close failed: ${e.message}`));
  })());

  try {
    await ab("set", "viewport", String(vw), String(vh));
    await ab("open", src.url);
    await ab("wait", "--load", "networkidle").catch(() => undefined);
    await ab("record", "start", webm, src.url);
    t0 = Date.now();
    await opts.ready?.();
    await ab("wait", "--load", "networkidle").catch(() => undefined);
    await sleep(600);
  } catch (e) {
    await close();
    throw e;
  }

  /** "@eN" → "role name", from the latest observe only. Cleared by every act: a ref keeps pointing at
   * its DOM node while the node's text changes ("Next" → "Place order"), so a name is only trusted
   * until the next input. */
  let refs = new Map<string, string>();

  const act = async (step: Step): Promise<ActionEvent | undefined> => {
    const caption = "caption" in step ? step.caption : undefined;
    const before = events.length;
    refs = new Map();
    try {
      switch (step.action) {
        case "click":
        case "fill":
        case "select": {
          if (typeof step.target !== "string") throw new Error("browser targets must be selector strings");
          const rect = await boxOf(step.target);
          events.push({
            tMs: now(), kind: step.action === "fill" ? "type" : "click", label: step.target, caption, rect,
            point: rect && centerOf(rect), zoom: step.zoom, redact: step.redact,
          });
          if (step.action === "click") await ab("click", step.target);
          else if (step.action === "fill") await ab("fill", step.target, step.value);
          else await ab("select", step.target, step.value);
          break;
        }
        case "press":
          events.push({ tMs: now(), kind: "press", label: step.key, caption });
          await ab("press", step.key);
          break;
        case "scroll":
          events.push({ tMs: now(), kind: "scroll", caption });
          await ab("scroll", step.direction ?? "down", String(step.px ?? 500));
          break;
        case "open":
          events.push({ tMs: now(), kind: "navigate", label: step.url, caption });
          await ab("open", step.url);
          await ab("wait", "--load", "networkidle").catch(() => undefined);
          break;
        case "wait":
          events.push({ tMs: now(), kind: "wait", caption });
          await sleep(step.ms);
          break;
        case "mark":
          events.push({ tMs: now(), kind: "mark", caption });
          break;
      }
    } catch (e) {
      events.length = before; // the action did not happen as logged
      throw e;
    }
    await sleep(stepWaitMs(step, 900));
    return events[before];
  };

  const observe = async (o: { screenshot?: string } = {}) => {
    const snapshot = await abJson<{ refs?: Record<string, { role?: string; name?: string }> }>("snapshot", "-i");
    refs = new Map(Object.entries(snapshot?.refs ?? {}).map(([k, v]) => [`@${k}`, [v.role, v.name].filter(Boolean).join(" ")]));
    if (o.screenshot) await ab("screenshot", o.screenshot);
    return { tMs: now(), snapshot, ...(o.screenshot ? { screenshot: o.screenshot } : {}) };
  };

  const finish = async (): Promise<CaptureResult> => {
    await sleep(800, false);
    await close();
    const mp4 = join(workDir, "capture.mp4");
    await toMp4(webm, mp4);
    const probe = await ffprobe(mp4);
    // The screencast starts slightly before `record start` returns and drops frames
    // when idle; rescale wall-clock action times onto the actual video length.
    const scale = wallMs > 0 ? probe.durationMs / wallMs : 1;
    for (const e of events) e.tMs = Math.max(0, Math.round(e.tMs * scale));
    log(`browser capture: ${probe.width}x${probe.height}, ${probe.durationMs}ms video / ${wallMs}ms wall (scale ${scale.toFixed(3)})`);
    return { videoPath: mp4, width: probe.width, height: probe.height, durationMs: probe.durationMs, events, realCursor: false, t0EpochMs: t0 };
  };

  // ponytail: the browser recorder lives in agent-browser's daemon; its death surfaces as a failed step or at stop.
  return { act, observe, close, finish, refLabel: (r) => refs.get(r), alive: () => true, elapsedMs: now, eventCount: () => events.length };
}

/** Drive a page with agent-browser while it records WebM, logging element boxes per action. */
export async function captureBrowser(src: BrowserSource, steps: Step[], workDir: string, opts: BrowserOptions = {}): Promise<CaptureResult> {
  return runSteps(await startBrowser(src, workDir, opts), steps);
}
