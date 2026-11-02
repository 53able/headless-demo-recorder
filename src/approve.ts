// Human approval of a desktop scenario version (plan §3.4, route 2). The model has no tool
// for this; only a user at a TTY can write runs/<runId>/approvals/<versionHash>.json.
//
// Layout (written by the controller):
//   runs/<runId>/run.json                      { allowApps: string[], bundleId: string }
//   runs/<runId>/scenarios/<versionHash>.json  scenario bytes; versionHash = sha256 hex of them
//   runs/<runId>/approvals/<versionHash>.json  { route, at, versionHash, allowApps, bundleId }

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { bundleRefusal } from "./appguard.ts";
import { ToolError } from "./errors.ts";
import { abortSignal } from "./exec.ts";
import type { Scenario } from "./types.ts";

const RUN_ID = /^[A-Za-z0-9][\w.-]*$/;
const HASH = /^[0-9a-f]{64}$/;

export type Approval = { route: "cli" | "launcher"; at: string; versionHash: string; allowApps: string[]; bundleId: string };

export function runPaths(runsDir: string, runId: string, versionHash: string) {
  if (!RUN_ID.test(runId)) throw new ToolError("approve", "BAD_ARGS", `invalid runId: ${runId}`, "after-fix");
  if (!HASH.test(versionHash)) throw new ToolError("approve", "BAD_ARGS", `versionHash must be 64 lowercase hex chars: ${versionHash}`, "after-fix");
  const dir = join(runsDir, runId);
  return {
    run: join(dir, "run.json"),
    scenario: join(dir, "scenarios", `${versionHash}.json`),
    approval: join(dir, "approvals", `${versionHash}.json`),
  };
}

export const sha256Hex = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Reason to refuse when the scenario bytes are not the version being approved. */
export function hashMismatch(bytes: string | Uint8Array, versionHash: string): string | undefined {
  const actual = sha256Hex(bytes);
  return actual === versionHash ? undefined : `scenario file hash ${actual} does not match ${versionHash}; it changed after the version was created`;
}

/** Everything the user must see before approving: apps, every step and caption, the hash. */
export function approvalSummary(scenario: Scenario, allowApps: string[], bundleId: string, versionHash: string): string {
  const lines = [
    `scenario:     ${scenario.name}`,
    `target app:   ${bundleId}${scenario.source?.type === "desktop" ? ` (${scenario.source.app})` : ""}`,
    `allowed apps: ${allowApps.join(", ")}`,
    `steps:`,
    ...(scenario.steps ?? []).map((s, i) => `  ${i + 1}. ${JSON.stringify(s)}`),
    ...(scenario.edit?.titles?.length ? ["titles:", ...scenario.edit.titles.map((t) => `  - ${t.text}`)] : []),
    `versionHash:  ${versionHash}`,
  ];
  return lines.join("\n");
}

const fail = (code: string, message: string) => new ToolError("approve", code, message, "after-fix");

export async function approve(runsDir: string, runId: string, versionHash: string): Promise<{ approval: string; record: Approval }> {
  const paths = runPaths(runsDir, runId, versionHash);
  // Refuse before showing anything: approving must not be possible from a script or the model.
  if (!process.stdin.isTTY) throw fail("NOT_A_TTY", "approve needs an interactive terminal; it refuses non-TTY input");

  const read = (p: string) => readFile(p).catch((e: Error) => Promise.reject(fail("NOT_FOUND", `cannot read ${p}: ${e.message}`)));
  const bytes = await read(paths.scenario);
  const mismatch = hashMismatch(bytes, versionHash);
  if (mismatch) throw fail("HASH_MISMATCH", mismatch);
  let scenario: Scenario;
  let meta: { allowApps?: unknown; bundleId?: unknown };
  try {
    scenario = JSON.parse(bytes.toString("utf8")) as Scenario;
    meta = JSON.parse((await read(paths.run)).toString("utf8")) as typeof meta;
  } catch (e) {
    if (e instanceof ToolError) throw e;
    throw fail("BAD_JSON", (e as Error).message);
  }
  const allowApps = Array.isArray(meta.allowApps) ? meta.allowApps.filter((a): a is string => typeof a === "string") : [];
  const bundleId = typeof meta.bundleId === "string" ? meta.bundleId : undefined;
  if (!allowApps.length) throw fail("NO_ALLOW_APPS", `${paths.run} has no allowApps`);
  const why = bundleRefusal(bundleId, allowApps);
  if (why) throw fail("APP_NOT_ALLOWED", why);

  process.stderr.write(`\n${approvalSummary(scenario, allowApps, bundleId!, versionHash)}\n\n`);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  // In raw TTY mode readline swallows ^C; forward it to the CLI's handler, which aborts the question.
  rl.on("SIGINT", () => process.kill(process.pid, "SIGINT"));
  const answer = await rl.question("Type `yes` to approve recording this exact version: ", { signal: abortSignal }).finally(() => rl.close());
  if (answer.trim() !== "yes") throw new ToolError("approve", "NOT_APPROVED", "approval declined", "after-fix");

  // The file may have changed while the user was reading.
  const again = hashMismatch(await read(paths.scenario), versionHash);
  if (again) throw fail("HASH_MISMATCH", again);
  const record: Approval = { route: "cli", at: new Date().toISOString(), versionHash, allowApps, bundleId: bundleId! };
  await mkdir(dirname(paths.approval), { recursive: true });
  await writeFile(paths.approval, JSON.stringify(record, null, 2));
  return { approval: paths.approval, record };
}
