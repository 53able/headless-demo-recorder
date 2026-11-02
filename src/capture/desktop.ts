import { spawn } from "node:child_process";
import { copyFile, lstat, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { bundleRefusal, parseBundleId } from "../appguard.ts";
import { abortSignal, exists, ffprobe, log, parseNdjson, run, runOk, sleep, spawnEnv, toMp4 } from "../exec.ts";
import { centerOf } from "../compile.ts";
import type { ActionEvent, CaptureResult, DesktopSource, DesktopTarget, NRect, Step } from "../types.ts";

type Env<T> = { ok: boolean; data: T; error?: { code: string; message: string; disposition?: { retry?: string } } };
type Bounds = { x: number; y: number; width: number; height: number };
type Win = { id: string; app_name: string; title: string; bounds: Bounds; visible: boolean; pid?: number };

const move = (from: string, to: string) =>
  rename(from, to).catch(async (e: NodeJS.ErrnoException) => {
    if (e.code !== "EXDEV") throw e;
    // Across volumes: a half-written copy must not be mistaken for the recording.
    await copyFile(from, to).catch(async (err) => {
      await rm(to, { force: true });
      throw err;
    });
    await rm(from);
  });

/** `openscreen record` always writes into the app's recordings folder (video, cursor telemetry,
 * session file). Move those into `workDir` as `desktop-raw.*` so nothing accumulates there.
 * The app's media-links registry is left alone: it is the app's file. */
async function adoptRecording(stdout: string, workDir: string): Promise<void> {
  const done = parseNdjson(stdout).find((e) => e.event === "done" && e.success === true) as { screenVideoPath?: string } | undefined;
  const video = done?.screenVideoPath;
  if (!video) return log("openscreen record reported no file (stopped by force?); a partial recording may remain in its recordings folder");
  // Only the recorder's own files: an absolute .mp4 and the two names derived from it, regular files only.
  if (!isAbsolute(video) || !video.endsWith(".mp4")) throw new Error(`unexpected recording path ${video}`);
  const files: [string, string][] = [
    [video, "desktop-raw.mp4"],
    [`${video}.cursor.json`, "desktop-raw.mp4.cursor.json"],
    [`${video.slice(0, -".mp4".length)}.session.json`, "desktop-raw.session.json"],
  ];
  for (const [from, name] of files) {
    if (!(await lstat(from).catch(() => undefined))?.isFile()) continue;
    await move(from, join(workDir, name)).catch((e: Error) => log(`could not move ${from}: ${e.message}`));
  }
}

export type DesktopOptions = {
  /** Bundle IDs input may be sent to (`--allow-app`). Deny-listed apps are refused regardless. */
  allowApps?: string[];
  /** Awaited once the recorder runs; video before the moment it resolves is trimmed (see `t0EpochMs`). */
  ready?: () => Promise<void>;
};

async function ad<T>(...args: string[]): Promise<T> {
  const out = await runOk("agent-desktop", args, { timeoutMs: 60_000 }).catch((e: Error) => {
    // agent-desktop exits non-zero on errors but still prints the envelope.
    const m = e.message.match(/\{"command".*\}/);
    if (m) return m[0];
    throw e;
  });
  const env = JSON.parse(out) as Env<T>;
  if (!env.ok) throw new Error(`agent-desktop ${args[0]}: ${env.error?.code} ${env.error?.message}`);
  return env.data;
}

/** Record one app window with OpenScreen while agent-desktop drives it headlessly. */
export async function captureDesktop(src: DesktopSource, steps: Step[], workDir: string, opts: DesktopOptions = {}): Promise<CaptureResult> {
  if (!opts.allowApps?.length) log("warning: no --allow-app given; any non-deny-listed app may receive input");
  let app = src.app;
  if (src.launch) {
    const r = await ad<{ app: string }>("launch", src.app);
    app = r.app; // localized process name (e.g. "計算機" for Calculator)
    await sleep(1000);
  }
  const wins = await ad<Win[]>("list-windows");
  const win = wins.find((w) => w.app_name === app && w.visible && w.bounds.width > 0);
  if (!win) throw new Error(`no visible window for app ${app}`);
  /** Refuse unless the window's process is an allowed app. Called before every input. */
  const guard = async () => {
    const r = win.pid ? await run("lsappinfo", ["info", "-only", "bundleid", String(win.pid)], { timeoutMs: 10_000 }) : undefined;
    const why = bundleRefusal(r?.code === 0 ? parseBundleId(r.stdout) : undefined, opts.allowApps?.length ? opts.allowApps : undefined);
    if (why) throw new Error(`APP_NOT_ALLOWED: ${why}`);
  };
  await guard(); // before the recorder starts
  const title = src.window ?? win.title;
  const wb = win.bounds;
  const norm = (b: Bounds): NRect => ({ x: (b.x - wb.x) / wb.width, y: (b.y - wb.y) / wb.height, w: b.width / wb.width, h: b.height / wb.height });

  const projectPath = join(workDir, "desktop.openscreen");
  const args = ["record", "--window", title, "--project", projectPath, "--json", ...(src.systemAudio ? ["--system-audio"] : [])];
  const rec = spawn("openscreen", args, { stdio: ["pipe", "pipe", "pipe"], env: spawnEnv() });
  let stdout = "";
  let t0 = 0;
  rec.stdin.on("error", () => undefined); // EPIPE if the child exits before "stop" is written
  rec.stderr.on("data", () => undefined);
  const finished = new Promise<number>((resolve) => {
    rec.on("error", () => resolve(1));
    rec.on("close", (code) => resolve(code ?? 1));
  });
  let startTimer: ReturnType<typeof setTimeout> | undefined;
  const started = new Promise<void>((resolve, reject) => {
    rec.stdout.on("data", (d: Buffer) => {
      stdout += d;
      if (!t0 && stdout.includes('"Recording started"')) {
        t0 = Date.now();
        resolve();
      }
    });
    rec.on("error", (e) => reject(new Error(`cannot start openscreen: ${e.message}`)));
    rec.on("close", (code) => reject(new Error(`openscreen record exited early (${code}): ${stdout.slice(-1000)}`)));
    startTimer = setTimeout(() => reject(new Error("openscreen record did not start within 30s (permission prompt?)")), 30_000);
    abortSignal.addEventListener("abort", () => reject(abortSignal.reason), { once: true });
  }).finally(() => clearTimeout(startTimer));

  /** Stop gracefully when recording, otherwise kill; never leave the recorder running. */
  const shutdown = async (graceful: boolean) => {
    if (rec.exitCode !== null || rec.signalCode !== null) return;
    if (graceful) rec.stdin.write("stop\n");
    else rec.kill("SIGTERM");
    const exited = await Promise.race([finished.then(() => true), sleep(graceful ? 20_000 : 5_000, false).then(() => false)]);
    if (!exited) {
      rec.kill("SIGKILL");
      await finished;
    }
  };

  const events: ActionEvent[] = [];
  const now = () => Date.now() - t0;

  const resolveRef = async (t: DesktopTarget | string): Promise<string> => {
    if (typeof t === "string") return t; // already a qualified ref
    await guard();
    const q = ["find", "--window-id", win.id, ...(t.role ? ["--role", t.role] : []), ...(t.name ? ["--name", t.name] : []), ...(t.text ? ["--text", t.text] : []), ...(t.exact ? ["--exact"] : [])];
    const r = await ad<{ matches: { ref_id?: string; interactive?: boolean }[] }>(...q);
    const m = r.matches.find((x) => x.ref_id && x.interactive) ?? r.matches.find((x) => x.ref_id);
    if (!m?.ref_id) throw new Error(`no element for ${JSON.stringify(t)}`);
    if (r.matches.length > 1) log(`warning: ${r.matches.length} matches for ${JSON.stringify(t)}, using the first`);
    return m.ref_id;
  };

  try {
    await started;
  } catch (e) {
    await shutdown(false);
    throw e;
  }
  let headMs = 0;
  try {
    const recordingStartedAt = t0;
    if (opts.ready) {
      await opts.ready();
      t0 = Date.now();
    }
    headMs = t0 - recordingStartedAt;
    await sleep(500);
    for (const step of steps) {
      const caption = "caption" in step ? step.caption : undefined;
      switch (step.action) {
        case "click":
        case "fill": {
          const ref = await resolveRef(step.target);
          const b = await ad<{ value: Bounds }>("get", ref, "--property", "bounds").catch(() => undefined);
          const rect = b ? norm(b.value) : undefined;
          events.push({
            tMs: now(), kind: step.action === "click" ? "click" : "type", label: JSON.stringify(step.target), caption, rect,
            point: rect && centerOf(rect), zoom: step.zoom, redact: step.redact,
          });
          await guard();
          if (step.action === "click") await ad("click", ref);
          else await ad("type", ref, step.value);
          break;
        }
        case "press":
          events.push({ tMs: now(), kind: "press", label: step.key, caption });
          await guard();
          await ad("press", step.key, "--app", app);
          break;
        case "wait":
          events.push({ tMs: now(), kind: "wait", caption });
          await sleep(step.ms);
          break;
        case "mark":
          events.push({ tMs: now(), kind: "mark", caption });
          break;
        default:
          throw new Error(`step ${step.action} is not supported for desktop sources`);
      }
      await sleep("waitMs" in step && step.waitMs !== undefined ? step.waitMs : 700);
    }
    await sleep(800);
  } finally {
    // Also runs when a step throws, so the recorder never outlives the work dir.
    await shutdown(true);
    // Success or not: move the recording out of OpenScreen's folder into the work dir, which
    // `--keep-work` (or a failed capture) keeps and a normal run removes.
    await adoptRecording(stdout, workDir).catch((e: Error) => log(`could not move the OpenScreen recording: ${e.message}`));
  }
  const code = await finished;
  const done = parseNdjson(stdout).find((e) => e.event === "done" && e.success === true) as { screenVideoPath?: string } | undefined;
  if (code !== 0 || !done?.screenVideoPath) throw new Error(`openscreen record failed (exit ${code}): ${stdout.slice(-1500)}`);
  const raw = join(workDir, "desktop-raw.mp4");
  if (!(await exists(raw))) throw new Error(`openscreen record reported ${done.screenVideoPath} but it could not be moved into ${workDir}`);
  const mp4 = join(workDir, "capture.mp4");
  await toMp4(raw, mp4, { startMs: headMs });
  const probe = await ffprobe(mp4);
  log(`desktop capture: window "${title}" ${probe.width}x${probe.height}, ${probe.durationMs}ms`);
  return { videoPath: mp4, width: probe.width, height: probe.height, durationMs: probe.durationMs, events, realCursor: false, t0EpochMs: t0 };
}
