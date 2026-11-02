import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Audit, Redactor } from "./audit.ts";
import { NodeCliAdapter, controllerArgs, parseCliStdout } from "./cli-adapter.ts";
import { checkEnv, EXPECTED_ENV, parseVersion } from "./env.ts";

// A fake CLI (not the real one): echoes argv and env, or hangs ignoring SIGTERM.
const FAKE = `
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "hang") { process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); }
else if (cmd === "garbage") { console.log("not json"); process.exit(1); }
else { console.error("progress"); console.log("noise"); console.log(JSON.stringify({ ok: true, cmd, rest, leaked: process.env.AGENT_BROWSER_ALLOWED_DOMAINS ?? null })); }
`;
const flags = { allowOrigins: ["http://127.0.0.1:4173"], allowApps: ["com.apple.calculator"], sessionName: "ca-x-1" };
let dir: string;
let adapter: NodeCliAdapter;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "adapter-test-"));
  await writeFile(join(dir, "cli.ts"), FAKE);
  adapter = new NodeCliAdapter({ cliPath: join(dir, "cli.ts"), killGraceMs: 300 });
});
afterAll(() => rm(dir, { recursive: true, force: true }));

test("fixed argv with controller flags; allowlisted env; single JSON parsed", async () => {
  process.env.AGENT_BROWSER_ALLOWED_DOMAINS = "*";
  const pids: number[] = [];
  const r = await adapter.cli({ cmd: "check", args: ["/tmp/a b; rm -rf ~.json"], flags, timeoutMs: 10_000, onSpawn: (p) => pids.push(p) });
  delete process.env.AGENT_BROWSER_ALLOWED_DOMAINS;
  expect(r.exitCode).toBe(0);
  expect(r.json.cmd).toBe("check");
  expect(r.json.rest).toEqual(["/tmp/a b; rm -rf ~.json", ...controllerArgs(flags)]);
  expect(r.json.leaked).toBeNull();
  expect(pids).toHaveLength(1);
});

test("controllerArgs carries every allowlist entry and the session name", () => {
  expect(controllerArgs(flags)).toEqual(["--controller-mode", "--allow-origin", "http://127.0.0.1:4173", "--allow-app", "com.apple.calculator", "--session-name", "ca-x-1"]);
});

test("missing JSON becomes an error result; capture failures are retry:no", async () => {
  const r = await adapter.cli({ cmd: "capture" as never, args: [], flags, timeoutMs: 10_000 });
  expect(r.json.ok).toBe(true); // fake treats unknown cmds as echo
  const g = await adapter.cli({ cmd: "garbage" as never, args: [], flags, timeoutMs: 10_000 });
  expect(g.json).toMatchObject({ ok: false, code: "BAD_OUTPUT" });
  expect(parseCliStdout('x\n{"ok":false,"retry":"no"}\n')).toEqual({ ok: false, retry: "no" });
});

test("timeout: SIGTERM, then SIGKILL after the grace period", async () => {
  const t0 = Date.now();
  const r = await adapter.cli({ cmd: "hang" as never, args: [], flags, timeoutMs: 300 });
  expect(r.timedOut).toBe(true);
  expect(r.json).toMatchObject({ ok: false, code: "TIMEOUT", retry: "no" });
  expect(Date.now() - t0).toBeGreaterThanOrEqual(550);
  expect(Date.now() - t0).toBeLessThan(5_000);
});

test("killInFlight stops a running child", async () => {
  const p = adapter.cli({ cmd: "hang" as never, args: [], flags, timeoutMs: 60_000 });
  await new Promise((r) => setTimeout(r, 200));
  await adapter.killInFlight();
  const r = await p;
  expect(r.timedOut).toBe(false);
  expect(r.exitCode === null || r.exitCode !== 0).toBe(true);
});

test("only allowlisted helper binaries", async () => {
  await expect(adapter.exec("sh" as never, ["-c", "echo"], { timeoutMs: 1000 })).rejects.toThrow("not allowed");
});

test("Redactor masks exact and embedded secrets, keys included", async () => {
  const r = new Redactor();
  r.add("hunter22");
  r.add("ab");
  expect(r.apply<unknown>({ a: "hunter22", b: ["x hunter22 y"], hunter22: 1, c: "ab", d: "abc" })).toEqual({ a: "***", b: ["x *** y"], "***": 1, c: "***", d: "abc" });
  const audit = new Audit(dir, r);
  await audit.append({ t: "t", tool: "x", args: { v: "hunter22" }, budget: {} });
  expect(await Bun.file(join(dir, "tools.jsonl")).text()).not.toContain("hunter22");
});

test("env checker: exact versions, missing is a mismatch", () => {
  expect(parseVersion("agent-browser 0.32.1")).toBe("0.32.1");
  expect(parseVersion('{"data":{"version":"1.0.2"}}')).toBe("1.0.2");
  expect(checkEnv({ ...EXPECTED_ENV }).ok).toBe(true);
  const r = checkEnv({ ...EXPECTED_ENV, pi: "0.84.4", openscreen: undefined });
  expect(r.ok).toBe(false);
  expect(r.mismatches.map((m) => m.tool)).toEqual(["pi", "openscreen"]);
});
