// Spawns `bun <abs>/src/cli.ts <cmd> ...` (and a few helper binaries) with a fixed argument
// array, an allowlisted environment, and a per-call timeout. Never goes through a shell.

import { type ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";
import { childEnv } from "../src/exec.ts";
import type { Adapter, CliCall, CliJson, CliResult, ExecBin, ExecResult } from "./types.ts";

export const DEFAULT_CLI_PATH = resolve(import.meta.dir, "../src/cli.ts");
const EXEC_BINS: ReadonlySet<ExecBin> = new Set(["agent-browser", "agent-desktop", "pgrep"]);
const MAX_CAPTURE = 4 * 1024 * 1024;

export type NodeCliAdapterOptions = {
  /** Absolute path of src/cli.ts (tests point this at a fake). */
  cliPath?: string;
  /** Interpreter for the CLI; defaults to the running bun. */
  bunPath?: string;
  /** SIGTERM → SIGKILL grace period. */
  killGraceMs?: number;
};

/** Controller flags as CLI arguments: --controller-mode, every allowlist entry, the session name. */
export function controllerArgs(flags: CliCall["flags"]): string[] {
  return [
    "--controller-mode",
    ...flags.allowOrigins.flatMap((o) => ["--allow-origin", o]),
    ...flags.allowApps.flatMap((a) => ["--allow-app", a]),
    "--session-name", flags.sessionName,
  ];
}

/** The CLI prints exactly one JSON object; take the last `{...}` line to tolerate stray output. */
export function parseCliStdout(stdout: string): CliJson | undefined {
  const lines = stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{"));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const j = JSON.parse(lines[i]!) as unknown;
      if (j && typeof j === "object" && !Array.isArray(j)) return j as CliJson;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

export class NodeCliAdapter implements Adapter {
  readonly cliPath: string;
  private readonly bunPath: string;
  private readonly killGraceMs: number;
  private readonly inFlight = new Set<ChildProcess>();

  constructor(opts: NodeCliAdapterOptions = {}) {
    this.cliPath = resolve(opts.cliPath ?? DEFAULT_CLI_PATH);
    this.bunPath = opts.bunPath ?? process.execPath;
    this.killGraceMs = opts.killGraceMs ?? 10_000;
  }

  async cli(call: CliCall): Promise<CliResult> {
    const args = [this.cliPath, call.cmd, ...call.args, ...controllerArgs(call.flags)];
    const r = await this.spawnCollect(this.bunPath, args, call.timeoutMs, call.onSpawn);
    if (r.timedOut) {
      return { exitCode: r.code, timedOut: true, pid: r.pid, json: { ok: false, code: "TIMEOUT", message: `${call.cmd} exceeded ${call.timeoutMs}ms; killed`, retry: "no" } };
    }
    const json = parseCliStdout(r.stdout) ?? {
      ok: false, code: "BAD_OUTPUT", retry: call.cmd === "capture" ? "no" : "after-fix",
      message: `${call.cmd} exited ${r.code} without a JSON result: ${r.stderr.slice(-1500)}`,
    };
    return { exitCode: r.code, timedOut: false, pid: r.pid, json };
  }

  exec(bin: ExecBin, args: string[], opts: { timeoutMs: number; onSpawn?: (pid: number) => void }): Promise<ExecResult> {
    if (!EXEC_BINS.has(bin)) return Promise.reject(new Error(`binary not allowed: ${bin}`));
    return this.spawnCollect(bin, args, opts.timeoutMs, opts.onSpawn);
  }

  async killInFlight(): Promise<void> {
    await Promise.all([...this.inFlight].map((p) => this.terminate(p)));
  }

  private terminate(p: ChildProcess): Promise<void> {
    if (p.exitCode !== null || p.signalCode !== null) return Promise.resolve();
    return new Promise((done) => {
      const t = setTimeout(() => {
        if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
      }, this.killGraceMs);
      p.once("close", () => {
        clearTimeout(t);
        done();
      });
      p.kill("SIGTERM");
    });
  }

  private spawnCollect(cmd: string, args: string[], timeoutMs: number, onSpawn?: (pid: number) => void): Promise<ExecResult> {
    return new Promise((resolveP, reject) => {
      if (!(timeoutMs > 0)) return reject(new Error(`no time left for ${cmd} (timeout ${timeoutMs}ms)`));
      const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: childEnv() });
      this.inFlight.add(p);
      if (p.pid !== undefined) onSpawn?.(p.pid);
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        void this.terminate(p);
      }, timeoutMs);
      p.stdout!.on("data", (d) => {
        if (stdout.length < MAX_CAPTURE) stdout += d;
      });
      p.stderr!.on("data", (d) => {
        stderr = (stderr + d).slice(-MAX_CAPTURE);
      });
      p.on("error", (e) => {
        clearTimeout(timer);
        this.inFlight.delete(p);
        reject(e);
      });
      p.on("close", (code) => {
        clearTimeout(timer);
        this.inFlight.delete(p);
        resolveP({ code, stdout, stderr, timedOut, pid: p.pid });
      });
    });
  }
}
