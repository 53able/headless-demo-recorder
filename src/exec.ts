import { spawn } from "node:child_process";
import { access } from "node:fs/promises";

export const exists = (p: string) => access(p).then(() => true, () => false);

export type RunResult = { code: number; stdout: string; stderr: string };

export const log = (...a: unknown[]) => console.error("[headless-demo-recorder]", ...a);

// Set by the CLI's SIGINT/SIGTERM handler. Normal work (run, sleep) stops; cleanup work
// (`cleanup: true`) still runs so `finally` blocks can stop recorders and close sessions.
const aborter = new AbortController();
export const abortSignal = aborter.signal;
export const requestAbort = (reason: string) => aborter.abort(new Error(reason));

// Variables a child may inherit. Everything else (notably AGENT_BROWSER_*) is dropped so the
// user's environment cannot widen what a child is allowed to do.
const ENV_ALLOW = ["PATH", "HOME", "TMPDIR", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ"];

/** Allowlisted environment for child processes. */
export function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ENV_ALLOW) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
}

/** Environment for every child process. Electron-based hosts (e.g. T3 Code) export
 * ELECTRON_RUN_AS_NODE=1, which makes the Electron `openscreen` binary start as plain Node. */
export function spawnEnv(env: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const { ELECTRON_RUN_AS_NODE: _, ...rest } = env;
  return rest;
}

type RunOpts = { input?: string; timeoutMs?: number; env?: Record<string, string>; cleanup?: boolean };

/** Run a command to completion. Never goes through a shell. */
export function run(cmd: string, args: string[], opts: RunOpts = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (!opts.cleanup && abortSignal.aborted) return reject(abortSignal.reason);
    const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env: spawnEnv(opts.env) });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    const stop = () => {
      p.kill("SIGINT");
      // Escalate if the child ignores SIGINT; reject only after it is gone.
      setTimeout(() => p.exitCode === null && p.signalCode === null && p.kill("SIGKILL"), 5_000).unref();
    };
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          stop();
        }, opts.timeoutMs)
      : null;
    const onAbort = () => {
      aborted = true;
      stop();
    };
    if (!opts.cleanup) abortSignal.addEventListener("abort", onAbort, { once: true });
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", reject);
    p.on("close", (code) => {
      if (timer) clearTimeout(timer);
      abortSignal.removeEventListener("abort", onAbort);
      if (aborted) return reject(abortSignal.reason);
      if (timedOut) return reject(new Error(`${cmd} timed out after ${opts.timeoutMs}ms`));
      resolve({ code: code ?? 1, stdout, stderr });
    });
    p.stdin.on("error", () => undefined);
    if (opts.input !== undefined) p.stdin.write(opts.input);
    p.stdin.end();
  });
}

export async function runOk(cmd: string, args: string[], opts: Omit<RunOpts, "input"> = {}): Promise<string> {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited ${r.code}\n${r.stderr.slice(-2000)}\n${r.stdout.slice(-2000)}`);
  }
  return r.stdout;
}

export function parseNdjson(text: string): Record<string, unknown>[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

/** Sleep that rejects when the CLI is interrupted; pass `abortable = false` in cleanup code. */
export const sleep = (ms: number, abortable = true) =>
  new Promise<void>((resolve, reject) => {
    if (abortable && abortSignal.aborted) return reject(abortSignal.reason);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortSignal.reason);
    };
    const t = setTimeout(() => {
      if (abortable) abortSignal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (abortable) abortSignal.addEventListener("abort", onAbort, { once: true });
  });

export type Probe = { width: number; height: number; durationMs: number; hasAudio: boolean };

export async function ffprobe(path: string): Promise<Probe> {
  const out = await runOk("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", path]);
  const j = JSON.parse(out) as { streams: { codec_type: string; width?: number; height?: number }[]; format: { duration?: string } };
  const v = j.streams.find((s) => s.codec_type === "video");
  if (!v?.width || !v.height) throw new Error(`no video stream in ${path}`);
  return {
    width: v.width,
    height: v.height,
    durationMs: Math.round(Number(j.format.duration ?? 0) * 1000),
    hasAudio: j.streams.some((s) => s.codec_type === "audio"),
  };
}

/** ffmpeg argv for `toMp4`. `startMs > 0` drops that much from the head (`-ss` before `-i`). */
export function toMp4Args(input: string, output: string, opts: { startMs?: number } = {}): string[] {
  return [
    "-y", "-v", "error", ...(opts.startMs && opts.startMs > 0 ? ["-ss", String(opts.startMs / 1000)] : []), "-i", input,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
    "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-r", "30",
    "-c:a", "aac", "-movflags", "+faststart", output,
  ];
}

/** Normalize any input video to constant-frame-rate H.264 MP4 that OpenScreen can decode. */
export async function toMp4(input: string, output: string, opts: { startMs?: number } = {}): Promise<void> {
  await runOk("ffmpeg", toMp4Args(input, output, opts));
}

/** Rendezvous for `n` parallel captures. `leave()` counts a party that will never arrive.
 * Releases on timeout too (with a warning) so one stuck capture cannot hang the others. */
export function barrier(n: number, timeoutMs: number): { arrive(): Promise<void>; leave(): void; fail(reason: unknown): void } {
  let count = 0;
  let failed: unknown;
  const waiters: { resolve(): void; reject(e: unknown): void }[] = [];
  const release = () => waiters.splice(0).forEach((w) => w.resolve());
  const bump = () => {
    if (++count >= n) release();
  };
  return {
    arrive() {
      if (abortSignal.aborted) return Promise.reject(abortSignal.reason);
      if (failed !== undefined) return Promise.reject(failed);
      return new Promise<void>((resolve, reject) => {
        const settle = () => {
          clearTimeout(timer);
          abortSignal.removeEventListener("abort", onAbort);
        };
        const done = () => {
          settle();
          resolve();
        };
        const onAbort = () => {
          settle();
          reject(abortSignal.reason);
        };
        const timer = setTimeout(() => {
          log(`warning: barrier timed out after ${timeoutMs}ms; continuing without all parties`);
          done();
        }, timeoutMs);
        abortSignal.addEventListener("abort", onAbort, { once: true });
        waiters.push({ resolve: done, reject: (e) => (settle(), reject(e)) });
        bump();
      });
    },
    leave: bump,
    /** A party failed before arriving: everyone waiting (or arriving later) is rejected instead of recording alone. */
    fail(reason) {
      failed = reason;
      waiters.splice(0).forEach((w) => w.reject(reason));
    },
  };
}
