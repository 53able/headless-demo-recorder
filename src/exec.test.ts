import { expect, test } from "bun:test";
import { childEnv, run, spawnEnv } from "./exec.ts";

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
