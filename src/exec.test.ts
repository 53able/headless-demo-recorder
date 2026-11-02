import { expect, test } from "bun:test";
import { childEnv, run } from "./exec.ts";

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
