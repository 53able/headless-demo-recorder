// Expected tool versions (pi/expected-env.json) and a pure checker. Probing is the caller's job:
//   pi --version, agent-browser --version, agent-desktop version,
//   plutil -extract CFBundleShortVersionString raw /Applications/Openscreen.app/Contents/Info.plist
// (`openscreen --version` opens the GUI; never use it.)

import expected from "./expected-env.json" with { type: "json" };

export type EnvVersions = { pi: string; agentBrowser: string; agentDesktop: string; openscreen: string };

export const EXPECTED_ENV: EnvVersions = expected;

/** First x.y.z in a tool's version output (handles `agent-browser 0.32.1` and agent-desktop's JSON). */
export function parseVersion(output: string): string | undefined {
  return output.match(/\d+\.\d+\.\d+/)?.[0];
}

export type EnvCheck = { ok: boolean; mismatches: { tool: keyof EnvVersions; expected: string; actual: string | undefined }[] };

/** Exact match for every tool; a missing version is a mismatch (fail closed). */
export function checkEnv(actual: Partial<Record<keyof EnvVersions, string | undefined>>, want: EnvVersions = EXPECTED_ENV): EnvCheck {
  const mismatches = (Object.keys(want) as (keyof EnvVersions)[])
    .filter((tool) => actual[tool] !== want[tool])
    .map((tool) => ({ tool, expected: want[tool], actual: actual[tool] }));
  return { ok: mismatches.length === 0, mismatches };
}
