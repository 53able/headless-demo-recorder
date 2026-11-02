// Interactive recording sessions: a detached server process holds the recorder open while an
// agent alternates `session observe` (look at the UI) and `session act` (one step), so it can
// decide each next step from what is on screen. `session stop` saves an ordinary project that
// `render` / `inspect` / a composition use like any other capture.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver } from "./capture/driver.ts";
import { ToolError, asToolError } from "./errors.ts";
import { exists, log, requestAbort, sleep, spawnEnv } from "./exec.ts";
import type { CaptureResult, Scenario } from "./types.ts";
import { browserRefKey, looksDestructive, normalizeSessionStep } from "./validate.ts";

export type SessionStatus = "starting" | "recording" | "stopping" | "stopped" | "failed";
export type SessionState = { status: SessionStatus; pid: number; socket: string; updatedAt: string; error?: unknown; reason?: string; result?: unknown };
/** Written by `session start`, read by the server. */
export type SessionConfig = {
  scenarioPath: string; scenario: Scenario; cwd: string;
  allowOrigins: string[]; allowApps: string[]; sessionName?: string;
  /** Sessions started with the same group share a runId, so a composition time-aligns them. */
  group?: string;
  keepWork: boolean;
  idleTimeoutMs: number;
};
export type Request =
  | { op: "status" }
  | { op: "observe"; screenshot?: boolean }
  | { op: "act"; step: unknown }
  | { op: "stop" };

export const sessionDir = (projDir: string) => join(projDir, "session");
const statePath = (projDir: string) => join(sessionDir(projDir), "state.json");
const configPath = (projDir: string) => join(sessionDir(projDir), "config.json");
export const logPath = (projDir: string) => join(sessionDir(projDir), "server.log");
/** macOS caps socket paths at 104 bytes, so the socket lives in the temp dir under a hash of the project
 * dir, inside a directory only this user can enter (on Linux tmpdir() is shared between users). */
const socketDir = () => join(tmpdir(), `hdr-sessions-${process.getuid?.() ?? "u"}`);
const socketPath = (projDir: string) => join(socketDir(), `${createHash("sha256").update(projDir).digest("hex").slice(0, 16)}.sock`);

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export async function readState(projDir: string): Promise<SessionState | undefined> {
  try {
    return JSON.parse(await readFile(statePath(projDir), "utf8")) as SessionState;
  } catch {
    return undefined;
  }
}

/** A session whose server is still running (it may be starting, recording or stopping). */
export async function liveSession(projDir: string): Promise<SessionState | undefined> {
  const s = await readState(projDir);
  return s && ["starting", "recording", "stopping"].includes(s.status) && alive(s.pid) ? s : undefined;
}

/** Launch the server detached, then wait until it is recording (or has failed). */
export async function launchServer(projDir: string, config: SessionConfig, cliPath: string, timeoutMs = 150_000): Promise<SessionState> {
  await rm(sessionDir(projDir), { recursive: true, force: true });
  await mkdir(sessionDir(projDir), { recursive: true });
  await writeFile(configPath(projDir), JSON.stringify(config, null, 2));
  const fd = openSync(logPath(projDir), "a");
  let pid: number | undefined;
  let exited = false;
  try {
    const child = spawn(process.execPath, [cliPath, "__session-serve", projDir], { cwd: config.cwd, detached: true, stdio: ["ignore", fd, fd], env: spawnEnv() });
    pid = child.pid;
    child.on("exit", () => (exited = true));
    child.unref();
  } finally {
    closeSync(fd);
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !exited) {
    await sleep(300);
    const s = await readState(projDir);
    if (s?.status === "recording") return s;
    if (s?.status === "failed") return s;
  }
  const s = await readState(projDir);
  if (s?.status === "recording" || s?.status === "failed") return s;
  // Gave up waiting: stop the server (it closes its browser/recorder on SIGTERM) instead of leaving it recording unattended.
  if (!exited && pid) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  const tail = (await readFile(logPath(projDir), "utf8").catch(() => "")).slice(-1500);
  throw new ToolError("capture", "SESSION_START_FAILED",
    exited ? "the session server exited before it started recording" : `the session server did not report recording within ${timeoutMs}ms; it was told to stop`, "no",
    `check ${logPath(projDir)} and the app/browser state (the scenario's steps may have partly run), then session start --force`, { log: tail });
}

/** Send one request to a running session and return its JSON reply. */
export async function request(projDir: string, req: Request, timeoutMs: number): Promise<Record<string, unknown>> {
  const s = await readState(projDir);
  if (!s) throw new ToolError("validate", "NO_SESSION", `${projDir} has no session`, "after-fix", "start one with: session start <scenario.json>");
  if (!["recording", "stopping"].includes(s.status) || !alive(s.pid)) {
    throw new ToolError("validate", "SESSION_NOT_RUNNING", `the session in ${projDir} is ${alive(s.pid) ? s.status : `${s.status} (server not running)`}`, "after-fix",
      s.status === "stopped" ? `it was saved; render it: render ${projDir} --scenario <file>`
        : s.status === "starting" && alive(s.pid) ? "it is still starting; run session status until it reports recording"
          : `see ${logPath(projDir)}; start a new session with --force`,
      s.error ? { error: JSON.stringify(s.error) } : undefined);
  }
  return new Promise((resolve, reject) => {
    const sock = createConnection(s.socket);
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new ToolError("capture", "SESSION_TIMEOUT", `no reply to ${req.op} within ${timeoutMs}ms`, "no",
        `the request may still run later (it waits behind earlier steps); check session status ${projDir} (events, busy) and observe before sending another step`));
    }, timeoutMs);
    sock.on("data", (d) => (buf += d));
    sock.on("error", (e) => {
      clearTimeout(timer);
      reject(new ToolError("capture", "SESSION_UNREACHABLE", `cannot reach the session server: ${e.message}`, "no", `see ${logPath(projDir)}`));
    });
    sock.on("end", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(buf) as Record<string, unknown>);
      } catch {
        reject(new ToolError("capture", "SESSION_BAD_REPLY", `unreadable reply: ${buf.slice(0, 300)}`, "no", `see ${logPath(projDir)}`));
      }
    });
    sock.end(JSON.stringify(req) + "\n");
  });
}

/** A failed observe/act inside a session: the recording is still running, so the agent should look
 * again and choose, not reset the app and re-record (what `retry: no` means for a scenario run). */
function inSession(e: unknown, hint: string): ToolError {
  const err = asToolError(e, "capture");
  if (err.code === "APP_NOT_ALLOWED") return err; // a guard refusal; fix --allow-app or the window, not the step
  err.retry = "after-fix";
  err.hint = hint;
  return err;
}

export type ServeHooks = {
  /** Start recording and return its driver (the scenario's own steps run first, if any). */
  start(config: SessionConfig): Promise<Driver>;
  /** Issues for one `act` step; any error refuses the step before anything runs. */
  validate(step: unknown, config: SessionConfig): string[];
  /** Save the finished capture as the project; returns the reply for `session stop`. */
  save(capture: CaptureResult, config: SessionConfig): Promise<Record<string, unknown>>;
};

/** Session-only check for string refs from `session observe`: the ref must come from this session's
 * latest observe (not another app's or an older snapshot), and the element it names goes through the
 * same irreversible-action guard as a selector or find query would. Returns issues; empty = allowed. */
export function refIssues(step: unknown, config: SessionConfig, driver: Pick<Driver, "refLabel">): string[] {
  const st = step as { action?: string; target?: unknown; value?: unknown; allowDestructive?: boolean };
  if (typeof st?.target !== "string") return [];
  const key = config.scenario.source.type === "desktop" ? st.target : browserRefKey(st.target);
  if (!key) return [];
  const label = driver.refLabel(key);
  if (label === undefined) return [`step.target: ${st.target} is not a ref from this session's latest observe; run session observe and use a ref from it`];
  const text = st.action === "select" && typeof st.value === "string" ? `${label} ${st.value}` : label;
  if (looksDestructive(text) && !st.allowDestructive && !config.scenario.allowDestructive) {
    return [`step: ${st.target} is "${label}", which looks irreversible. Choose another step, or after confirming it is harmless set "allowDestructive": true on this step`];
  }
  return [];
}

/** The server process (`__session-serve`). Resolves once the session is stopped and saved. */
export async function serve(projDir: string, hooks: ServeHooks): Promise<Record<string, unknown>> {
  // Signals are handled from the start: during startup they abort the work in flight (the scenario's
  // steps, the browser launch), afterwards they stop and save. A second signal gives up and exits.
  const sig: Sig = { on: (s) => { sig.signalled = s; requestAbort(`${s} while starting`); } };
  let count = 0;
  const handlers = (["SIGINT", "SIGTERM"] as const).map((s) => [s, () => {
    if (++count === 1) return sig.on(s);
    log(`${s} again: closing the recorder and exiting without saving`);
    void Promise.race([sig.close?.() ?? sig.starting ?? Promise.resolve(), sleep(10_000, false)]).finally(() => process.exit(143));
  }] as const);
  for (const [s, h] of handlers) process.on(s, h);
  try {
    return await serveInner(projDir, hooks, sig);
  } finally {
    for (const [s, h] of handlers) process.off(s, h);
  }
}

type Sig = { signalled?: string; on: (s: string) => void; close?: () => Promise<void>; starting?: Promise<unknown> };

async function serveInner(projDir: string, hooks: ServeHooks, sig: Sig): Promise<Record<string, unknown>> {
  const config = JSON.parse(await readFile(configPath(projDir), "utf8")) as SessionConfig;
  const sock = socketPath(projDir);
  const setState = (status: SessionStatus, extra: Partial<SessionState> = {}) =>
    writeFile(statePath(projDir), JSON.stringify({ status, pid: process.pid, socket: sock, updatedAt: new Date().toISOString(), ...extra }, null, 2));
  await setState("starting");

  let driver: Driver;
  try {
    const starting = hooks.start(config);
    sig.starting = starting.catch(() => undefined); // settles after the start's own cleanup
    driver = await starting;
  } catch (e) {
    const err = asToolError(e, "capture");
    await setState("failed", { error: err, ...(sig.signalled ? { reason: sig.signalled } : {}) });
    return { ok: false, error: err };
  }
  const abort = async (reason: string, e?: unknown) => {
    await driver.close();
    const err = e === undefined ? new ToolError("capture", "INTERRUPTED", `${reason} while starting`, "no", "the browser/recorder was closed; check the app state") : asToolError(e, "capture");
    await setState("failed", { reason, error: err });
    return { ok: false, error: err };
  };
  sig.close = () => driver.close();
  if (sig.signalled) return abort(sig.signalled);
  sig.on = (s) => void (sig.signalled = s); // recorded; stopped and saved once the server is up

  // L-1: any failure from here on must close the driver, or the recorder keeps running unowned.
  try {
    await mkdir(socketDir(), { recursive: true, mode: 0o700 });
    await chmod(socketDir(), 0o700);
    await rm(sock, { force: true });
  } catch (e) {
    return abort("cannot prepare the session socket directory", e);
  }
  // allowHalfOpen: the client ends its side after the request; the reply still has to go back.
  const server = createServer({ allowHalfOpen: true });
  let busy: Promise<unknown> = Promise.resolve();
  let inFlight = 0;
  let lastActivity = Date.now();
  let stopping: Promise<Record<string, unknown>> | undefined;
  let done!: (r: Record<string, unknown>) => void;
  const finished = new Promise<Record<string, unknown>>((r) => (done = r));

  const stop = (reason: string) => (stopping ??= (async () => {
    await setState("stopping", { reason });
    let reply: Record<string, unknown>;
    try {
      const capture = await driver.finish();
      reply = await hooks.save(capture, config);
      await setState("stopped", { reason, result: reply });
    } catch (e) {
      await driver.close();
      const err = asToolError(e, "capture", { workDir: join(projDir, "work") });
      reply = JSON.parse(JSON.stringify(err)) as Record<string, unknown>;
      await setState("failed", { reason, error: err });
    }
    done(reply);
    return reply;
  })());
  /** Steps must not interleave on the UI, and stopping must not cut a step in half: everything that
   * touches the driver runs on one queue. */
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    inFlight++;
    const run = busy.then(fn).finally(() => {
      inFlight--;
      lastActivity = Date.now();
    });
    busy = run.catch(() => undefined);
    return run;
  };
  const recorderGone = () => {
    if (driver.alive()) return undefined;
    void stop("the recorder exited");
    return new ToolError("capture", "RECORDER_DIED", "the recorder exited on its own (window closed, crash, permission revoked?)", "no",
      `what was recorded is being saved or reported in session status ${projDir}; check the app, then start a new session with --force`);
  };

  const handle = async (req: Request): Promise<Record<string, unknown>> => {
    if (stopping && req.op !== "stop") throw new ToolError("validate", "SESSION_NOT_RUNNING", "the session is stopping", "after-fix");
    switch (req.op) {
      case "observe": {
        const gone = recorderGone();
        if (gone) throw gone;
        const shot = req.screenshot ? join(sessionDir(projDir), `observe-${Date.now()}.png`) : undefined;
        try {
          return { ok: true, stage: "observe", ...(await driver.observe({ screenshot: shot })) };
        } catch (e) {
          throw inSession(e, "the recording continues; observe again, or stop the session");
        }
      }
      case "act": {
        // A dead recorder ends the session whatever the step is; say that first.
        const gone = recorderGone();
        if (gone) throw gone;
        const step = normalizeSessionStep(req.step, config.scenario.source);
        const issues = hooks.validate(step, config);
        if (!issues.length) issues.push(...refIssues(step, config, driver));
        if (issues.length) throw new ToolError("validate", "INVALID_STEP", issues.join("\n"), "after-fix", "nothing was executed; the recording continues");
        try {
          const event = await driver.act(step as never);
          return { ok: true, stage: "act", tMs: driver.elapsedMs(), event };
        } catch (e) {
          throw inSession(e, "the recording continues and the step was left out of the log; run `session observe` before choosing the next step (the step may have partly run)");
        }
      }
      case "stop":
        return stop("requested");
    }
    throw new ToolError("validate", "BAD_REQUEST", `unknown op ${(req as { op?: unknown }).op}`, "after-fix");
  };
  // Answered off the queue, so it works while a long step runs.
  const status = () => ({
    ok: true, stage: "session", status: stopping ? "stopping" : driver.alive() ? "recording" : "recorder exited",
    tMs: driver.elapsedMs(), events: driver.eventCount(), busy: inFlight > 0,
  });

  server.on("connection", (c: Socket) => {
    let buf = "";
    const onData = (d: Buffer) => {
      buf += d;
      if (!buf.includes("\n")) return;
      c.off("data", onData); // one request per connection; anything after the newline is ignored
      let req: Request;
      try {
        req = JSON.parse(buf.slice(0, buf.indexOf("\n"))) as Request;
      } catch {
        c.end(JSON.stringify(new ToolError("validate", "BAD_REQUEST", "request is not JSON", "after-fix")) + "\n");
        return;
      }
      // status is read-only: it neither waits for the queue nor keeps an idle session alive.
      const reply = req.op === "status" ? Promise.resolve(status()) : enqueue(() => handle(req));
      reply.then(
        (r) => c.end(JSON.stringify(r) + "\n"),
        (e: unknown) => c.end(JSON.stringify(asToolError(e, "capture")) + "\n"),
      );
    };
    c.on("data", onData);
    c.on("error", () => undefined);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(sock, resolve);
    });
  } catch (e) {
    return abort("cannot listen on the session socket", e);
  }
  await setState("recording");
  log(`session recording: ${projDir} (socket ${sock})`);

  // Never leave a recorder running unattended: stop and save after the idle timeout (not while a step runs).
  const idle = setInterval(() => {
    if (!stopping && inFlight === 0 && Date.now() - lastActivity > config.idleTimeoutMs) void enqueue(() => stop(`idle for ${config.idleTimeoutMs}ms`));
  }, 1000);
  sig.on = (s) => void enqueue(() => stop(s));
  if (sig.signalled) void enqueue(() => stop(sig.signalled!));
  const reply = await finished;
  clearInterval(idle);
  // Stop accepting, and exit only after open connections (the `stop` reply among them) are flushed.
  await Promise.race([new Promise<void>((r) => server.close(() => r())), sleep(10_000, false)]);
  await rm(sock, { force: true });
  return reply;
}

export const hasSessionFiles = (projDir: string) => exists(sessionDir(projDir));
