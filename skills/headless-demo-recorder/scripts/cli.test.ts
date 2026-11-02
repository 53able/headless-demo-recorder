import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./exec.ts";

const cli = join(import.meta.dir, "cli.ts");
const scenario = (name: string, out: string) => ({ name, source: { type: "browser", url: "https://example.com/" }, steps: [], output: { path: out } });

/** `check` (R0) reports a composition whose project dir would overwrite another kind of project. */
test("check: PROJECT_COLLISION in both directions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hdr-collide-"));
  try {
    const a = join(dir, "a.json");
    await writeFile(a, JSON.stringify({ ...scenario("a", join(dir, "a.mp4")), edit: { redact: [{ rect: { x: 0, y: 0, w: 0.2, h: 0.2 }, startMs: 0, endMs: 1000 }] } }));
    const comp = (out: string) => ({ name: "c", scenarios: [a], scenes: [{ layout: "single", streams: [{ scenario: "a" }] }], output: { path: out } });
    const check = async (c: object) => {
      const p = join(dir, "comp.json");
      await writeFile(p, JSON.stringify(c));
      return JSON.parse((await run("bun", [cli, "check", p])).stdout) as { ok: boolean; issues: { path: string; message: string }[] };
    };

    const valid = await check(comp(join(dir, "c.mp4")));
    expect(valid.ok).toBe(true);
    expect(valid.issues.some((i) => i.message.includes("redact"))).toBe(false);

    // The composition's output lands on an existing single-scenario project.
    await mkdir(join(dir, "solo.project"));
    await writeFile(join(dir, "solo.project", "capture.json"), "{}");
    const r1 = await check(comp(join(dir, "solo.mp4")));
    expect(r1.ok).toBe(false);
    expect(r1.issues.some((i) => i.path === "output.path" && i.message.includes("PROJECT_COLLISION"))).toBe(true);
    // run stops before launching anything, with the same code agents branch on.
    const run1 = JSON.parse((await run("bun", [cli, "run", join(dir, "comp.json")])).stdout) as { ok: boolean; code: string };
    expect(run1).toMatchObject({ ok: false, code: "PROJECT_COLLISION" });

    // A referenced scenario's project is a composition's project.
    await mkdir(join(dir, "a.project"));
    await writeFile(join(dir, "a.project", "composition.json"), "{}");
    const r2 = await check(comp(join(dir, "c.mp4")));
    expect(r2.ok).toBe(false);
    expect(r2.issues.some((i) => i.path === "scenarios[0]" && i.message.includes("PROJECT_COLLISION"))).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("schema: the types, the guide and the examples, from any directory", async () => {
  const r = JSON.parse((await run("bun", [cli, "schema"])).stdout) as { ok: boolean; guide: string; examples: string[]; types: string };
  expect(r.ok).toBe(true);
  expect(r.guide.endsWith("SKILL.md")).toBe(true);
  expect(r.types).toContain("export type Scenario");
  expect(r.types).toContain("export type Composition");
  expect(r.examples.some((p) => p.endsWith("composition-calc-wiki.json"))).toBe(true);
});

for (const failingSource of ["browser", "file"] as const) {
  test(`composition: ${failingSource} preparation failure prevents peer actions`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "hdr-start-failure-"));
    try {
      const log = join(dir, "calls.jsonl");
      const browser = join(dir, "agent-browser");
      await writeFile(browser, `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
process.exit(args.includes("record") && args.includes("start") && args.includes("test-a") ? 1 : 0);
`);
      await chmod(browser, 0o755);
      const ffmpeg = join(dir, "ffmpeg");
      await writeFile(ffmpeg, "#!/bin/sh\nexit 1\n");
      await chmod(ffmpeg, 0o755);
      const paths = ["a", "b"].map((name) => join(dir, `${name}.json`));
      for (const [i, name] of ["a", "b"].entries()) {
        await writeFile(paths[i]!, JSON.stringify({
          ...scenario(name, join(dir, `${name}.mp4`)),
          ...(name === "a" && failingSource === "file" ? { source: { type: "file", path: join(dir, "missing.mp4") } } : { steps: [{ action: "press", key: "Enter" }] }),
        }));
      }
      const composition = join(dir, "c.json");
      await writeFile(composition, JSON.stringify({ name: "c", scenarios: paths, scenes: [{ layout: "side-by-side", streams: [{ scenario: "a" }, { scenario: "b" }] }], output: { path: join(dir, "c.mp4") } }));
      const result = await run(process.execPath, [cli, "run", composition, "--session-name", "test"], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } as Record<string, string> });
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, code: "CAPTURE_PARTIAL_FAILED" });
      const calls = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
      expect(calls.some((args) => args.includes("press"))).toBe(false);
      expect(calls.some((args) => args.includes("close"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
