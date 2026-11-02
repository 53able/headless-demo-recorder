import { join } from "node:path";
import { childEnv, ffprobe, log, run, runOk, sleep, toMp4 } from "../exec.ts";
import type { ActionEvent, BrowserSource, CaptureResult, NRect, Step } from "../types.ts";
import { allowedDomains } from "../validate.ts";

export type BrowserOptions = {
  /** User-supplied origins; passed to agent-browser as `--allowed-domains` (host only). */
  allowOrigins?: string[];
  /** agent-browser session name chosen by the caller, so it can close the session itself. */
  sessionName?: string;
};

type Box = { x: number; y: number; width: number; height: number };

/** Drive a page with agent-browser while it records WebM, logging element boxes per action. */
export async function captureBrowser(src: BrowserSource, steps: Step[], workDir: string, opts: BrowserOptions = {}): Promise<CaptureResult> {
  const [vw, vh] = src.viewport ?? [1280, 720];
  const session = opts.sessionName ?? `headless-demo-recorder-${process.pid}-${Date.now()}`;
  if (!opts.allowOrigins?.length) log("warning: no --allow-origin given; the browser may reach any host");
  // Every invocation carries the same restriction, including record stop/close.
  const base = ["--session", session, ...(opts.allowOrigins?.length ? ["--allowed-domains", allowedDomains(opts.allowOrigins)] : [])];
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

  try {
    await ab("set", "viewport", String(vw), String(vh));
    await ab("open", src.url);
    await ab("wait", "--load", "networkidle").catch(() => undefined);
    await ab("record", "start", webm, src.url);
    t0 = Date.now();
    await ab("wait", "--load", "networkidle").catch(() => undefined);
    await sleep(600);

    for (const step of steps) {
      const caption = "caption" in step ? step.caption : undefined;
      switch (step.action) {
        case "click":
        case "fill": {
          if (typeof step.target !== "string") throw new Error("browser targets must be selector strings");
          const rect = await boxOf(step.target);
          const ev: ActionEvent = {
            tMs: now(), kind: step.action === "click" ? "click" : "type", label: step.target, caption, rect,
            point: rect && { cx: rect.x + rect.w / 2, cy: rect.y + rect.h / 2 }, zoom: step.zoom, redact: step.redact,
          };
          events.push(ev);
          if (step.action === "click") await ab("click", step.target);
          else await ab("fill", step.target, step.value);
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
      await sleep("waitMs" in step && step.waitMs !== undefined ? step.waitMs : 900);
    }
    await sleep(800);
  } finally {
    wallMs = t0 ? Date.now() - t0 : 0;
    if (t0) await run("agent-browser", [...base, "record", "stop"], { timeoutMs: 60_000, env, cleanup: true }).catch((e: Error) => log(`record stop failed: ${e.message}`));
    await run("agent-browser", [...base, "close"], { timeoutMs: 30_000, env, cleanup: true });
  }

  const mp4 = join(workDir, "capture.mp4");
  await toMp4(webm, mp4);
  const probe = await ffprobe(mp4);
  // The screencast starts slightly before `record start` returns and drops frames
  // when idle; rescale wall-clock action times onto the actual video length.
  const scale = wallMs > 0 ? probe.durationMs / wallMs : 1;
  for (const e of events) e.tMs = Math.max(0, Math.round(e.tMs * scale));
  log(`browser capture: ${probe.width}x${probe.height}, ${probe.durationMs}ms video / ${wallMs}ms wall (scale ${scale.toFixed(3)})`);
  return { videoPath: mp4, width: probe.width, height: probe.height, durationMs: probe.durationMs, events, realCursor: false };
}
