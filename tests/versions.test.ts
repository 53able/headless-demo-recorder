import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { OPENSCREEN_VERIFIED, TOOL_VERSIONS } from "../skills/headless-demo-recorder/scripts/doctor.ts";

const exact = (v: string) => `(?<![\\d.])${v.replaceAll(".", "\\.")}(?![\\d.])`;

// README quotes the tool versions; doctor.ts holds them. Keep them in step.
test("README's tool versions match doctor.ts", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  for (const [tool, { min, verified }] of Object.entries(TOOL_VERSIONS)) {
    const quoted = [...readme.matchAll(new RegExp("`" + tool + "`（([^）]*)）", "g"))].map((m) => m[1]!);
    expect(quoted.length).toBeGreaterThan(0);
    for (const q of quoted) expect(q).toMatch(new RegExp(`${exact(min)} 以上`));
    expect(quoted.some((q) => new RegExp(`${exact(verified)} で確認`).test(q))).toBe(true);
  }
  const openscreen = [...readme.matchAll(/(?:OpenScreen|Openscreen\.app`) ?[（の][^。\n]*?(\d+\.\d+\.\d+) で確認済み/g)].map((m) => m[1]);
  expect(openscreen.length).toBeGreaterThan(0);
  for (const v of openscreen) expect(v).toBe(OPENSCREEN_VERIFIED);
});
