import { expect, test } from "bun:test";
import { barrier, childEnv, run, spawnEnv, toMp4Args } from "./exec.ts";

test("run never passes ELECTRON_RUN_AS_NODE to a child", async () => {
  process.env.ELECTRON_RUN_AS_NODE = "1";
  try {
    expect(spawnEnv().ELECTRON_RUN_AS_NODE).toBeUndefined(); // used by desktop.ts's direct spawn
    for (const env of [undefined, { ...process.env } as Record<string, string>]) {
      const r = await run("/usr/bin/env", [], { env });
      expect(r.stdout).not.toContain("ELECTRON_RUN_AS_NODE");
      expect(r.stdout).toContain("PATH=");
    }
  } finally {
    delete process.env.ELECTRON_RUN_AS_NODE;
  }
});

test("child env is allowlisted and drops AGENT_BROWSER_*", async () => {
  process.env.AGENT_BROWSER_ALLOWED_DOMAINS = "*";
  process.env.SOME_SECRET = "x";
  try {
    const env = childEnv();
    expect(env.PATH).toBe(process.env.PATH!);
    expect(Object.keys(env).some((k) => k.startsWith("AGENT_BROWSER_"))).toBe(false);
    expect(env.SOME_SECRET).toBeUndefined();
    const r = await run("/usr/bin/env", [], { env });
    expect(r.stdout).not.toContain("AGENT_BROWSER_");
    expect(r.stdout).not.toContain("SOME_SECRET");
  } finally {
    delete process.env.AGENT_BROWSER_ALLOWED_DOMAINS;
    delete process.env.SOME_SECRET;
  }
});

test("barrier resolves when all parties arrive", async () => {
  const b = barrier(2, 5_000);
  let released = false;
  const a = b.arrive().then(() => (released = true));
  await Promise.resolve();
  expect(released).toBe(false);
  await Promise.all([a, b.arrive()]);
  expect(released).toBe(true);
});

test("barrier counts a leaver as arrived", async () => {
  const b = barrier(3, 5_000);
  b.leave();
  await Promise.all([b.arrive(), b.arrive()]);
});

test("barrier resolves on timeout", async () => {
  const t = Date.now();
  await barrier(2, 50).arrive();
  expect(Date.now() - t).toBeGreaterThanOrEqual(40);
});

test("toMp4Args puts -ss before -i only when startMs > 0", () => {
  const plain = toMp4Args("in.webm", "out.mp4");
  expect(plain).not.toContain("-ss");
  expect(toMp4Args("in.webm", "out.mp4", { startMs: 0 })).toEqual(plain);
  const trimmed = toMp4Args("in.webm", "out.mp4", { startMs: 1500 });
  expect(trimmed[trimmed.indexOf("-ss") + 1]).toBe("1.5");
  expect(trimmed.indexOf("-ss")).toBeLessThan(trimmed.indexOf("-i"));
});

test("barrier.fail rejects waiting and later parties", async () => {
  const g = barrier(2, 10_000);
  const waiting = g.arrive();
  g.fail(new Error("a failed first"));
  await expect(waiting).rejects.toThrow("a failed first");
  await expect(g.arrive()).rejects.toThrow("a failed first");
});
