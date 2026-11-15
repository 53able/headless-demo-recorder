// Read-only preflight: are the tools installed and permitted? Never opens a GUI.

import { run } from "./exec.ts";

/** `warning`: ok, but worth telling the user (a tool newer than the version this skill was checked with). */
export type Check = { name: string; ok: boolean; detail: string; fix?: string; warning?: string };

async function which(cmd: string): Promise<string | null> {
  const r = await run("which", [cmd]).catch(() => null);
  return r && r.code === 0 ? r.stdout.trim() : null;
}

/** True when the first x.y.z in `text` is at least `min`. False when no version is found. */
export function atLeast(text: string, min: string): boolean {
  const m = text.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return false;
  const a = m.slice(1).map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  return true;
}

/** The one place for tool versions (README: 必要環境 quotes them; tests/versions.test.ts keeps it in step).
 * `min`: the oldest version the current code was checked with; older fails. `verified`: the newest version
 * the real-recording checks (AGENTS.md) and the version notes in SKILL.md were made with; newer passes with
 * a warning, since agent-browser and agent-desktop change behavior between minor versions. Raise `verified`
 * after running those checks with a newer version. */
export const TOOL_VERSIONS = {
  // 0.43.0 (2026-11-15): bun test (session and ws-constants tests drive the real agent-browser),
  // tests/integration/ab-ports.ts, and the new-tab, ref and WebSocket notes re-measured.
  "agent-browser": { min: "0.41.0", verified: "0.43.0" },
  // min 1.3.0: the press, window and tab guards rely on it (press --window-id refusing a background window,
  // list-windows' accessible field); nothing older was checked with this code. verified 1.3.1 (2026-11-15):
  // the real-recording checks in AGENTS.md, and those behaviors re-measured.
  "agent-desktop": { min: "1.3.0", verified: "1.3.1" },
} as const;
/** The OpenScreen version the project format was verified against (render.ts); not a checked minimum. */
export const OPENSCREEN_VERIFIED = "2.2.0";

/** The tool's version from `agent-desktop version`: `data.version`. The top-level `version` is the
 * envelope's (2.6 on agent-desktop 1.3.0), not the tool's. */
export function agentDesktopVersion(stdout: string): string {
  try {
    const v = (JSON.parse(stdout) as { data?: { version?: unknown } }).data?.version;
    return typeof v === "string" ? v : "";
  } catch {
    return "";
  }
}

/** The version check of one tool. `version`: the tool's own version as read from its output ("" when it
 * could not be read); `output`: what the command printed, shown when the version cannot be read. */
export function versionCheck(tool: keyof typeof TOOL_VERSIONS, ran: boolean, version: string, output = version): Check {
  const { min, verified } = TOOL_VERSIONS[tool];
  const name = `${tool} version`;
  const v = version.match(/\d+\.\d+\.\d+(?:-[\w.]+)?/)?.[0];
  // Unreadable is not "too old": a newer release may print another format. Never suggest a downgrade for it.
  if (!ran || !v) return { name, ok: false, detail: output.trim().slice(0, 200), fix: `cannot read the ${tool} version (needs ${min}+); tell the user what it printed` };
  const core = v.replace(/-.*/, "");
  const prerelease = core !== v;
  // A prerelease of the minimum (1.3.0-beta.1) comes before it.
  if (!atLeast(core, min) || (prerelease && core === min)) return { name, ok: false, detail: v, fix: `npm i -g ${tool}@${verified} (needs ${min}+, checked with ${verified})` };
  const newer = !atLeast(verified, core);
  return {
    name, ok: true, detail: v,
    ...(newer || prerelease
      ? { warning: `${tool} ${v} is ${prerelease ? "a prerelease" : `newer than ${verified}`}, not the version this skill was checked with (${verified}); its behavior may differ` }
      : {}),
  };
}

/** What a newer release on npm means here, or undefined when nothing is newer. Both cases are worth
 * telling the user every time: a release past `verified` has not been checked with this skill, and an
 * install behind the latest one misses its fixes. */
export function latestCheck(tool: keyof typeof TOOL_VERSIONS, installed: string, latest: string): Check {
  const { verified } = TOOL_VERSIONS[tool];
  const name = `${tool} latest`;
  const unchecked = !atLeast(verified, latest);
  const behind = /\d+\.\d+\.\d+/.test(installed) && !atLeast(installed, latest);
  if (!unchecked && !behind) return { name, ok: true, detail: latest };
  const notes = [
    ...(behind ? [`${installed} is installed (the user may update with npm i -g ${tool}@${latest})`] : []),
    ...(unchecked ? [`this skill was checked with ${verified} only (maintainers: run the checks in AGENTS.md with it and raise verified)`] : []),
  ];
  return { name, ok: true, detail: latest, warning: `${tool} ${latest} is out: ${notes.join("; ")}` };
}

/** The latest version on the npm registry, or undefined when it cannot be read (offline, sandboxed). */
export async function npmLatest(tool: string, timeoutMs = 5000): Promise<string | undefined> {
  try {
    const r = await fetch(`https://registry.npmjs.org/${tool}/latest`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return undefined;
    const v = ((await r.json()) as { version?: unknown }).version;
    return typeof v === "string" && /^\d+\.\d+\.\d+/.test(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

export async function doctor(): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);
  // Never fails the preflight: a release newer than what is installed or checked becomes a warning.
  const latestOf = async (tool: keyof typeof TOOL_VERSIONS, installed: string): Promise<Check> => {
    const latest = await npmLatest(tool);
    return latest ? latestCheck(tool, installed, latest) : { name: `${tool} latest`, ok: true, detail: "unknown (the npm registry could not be reached)" };
  };

  for (const [cmd, fix] of [
    ["ffmpeg", "brew install ffmpeg"],
    ["ffprobe", "brew install ffmpeg"],
    ["agent-browser", "npm i -g agent-browser"],
    ["agent-desktop", "npm i -g agent-desktop"],
    ["openscreen", `install OpenScreen (verified with ${OPENSCREEN_VERIFIED}) and put its CLI on PATH`],
  ] as const) {
    const path = await which(cmd);
    add({ name: cmd, ok: !!path, detail: path ?? "not found", fix: path ? undefined : fix });
  }

  if (checks.find((c) => c.name === "agent-browser")?.ok) {
    const r = await run("agent-browser", ["--version"]);
    add(versionCheck("agent-browser", r.code === 0, r.stdout.match(/\d+\.\d+\.\d+(?:-[\w.]+)?/)?.[0] ?? "", r.stdout));
    add(await latestOf("agent-browser", r.stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? ""));
  }
  if (checks.find((c) => c.name === "agent-desktop")?.ok) {
    const v = await run("agent-desktop", ["version"]);
    add(versionCheck("agent-desktop", v.code === 0, agentDesktopVersion(v.stdout), v.stdout));
    add(await latestOf("agent-desktop", agentDesktopVersion(v.stdout)));
    const p = await run("agent-desktop", ["permissions"]);
    try {
      const d = JSON.parse(p.stdout).data as Record<string, { state: string }>;
      for (const k of ["accessibility", "screen_recording"]) {
        const st = d[k]?.state ?? "unknown";
        add({ name: `permission: ${k}`, ok: st === "granted", detail: st, fix: st === "granted" ? undefined : "grant it to this terminal in System Settings > Privacy & Security (the user must do this)" });
      }
    } catch {
      add({ name: "permissions", ok: false, detail: p.stdout.slice(0, 200) || p.stderr.slice(0, 200) });
    }
  }
  if (checks.find((c) => c.name === "openscreen")?.ok) {
    // `help` prints usage without launching the editor window (`--version` would open the GUI).
    const h = await run("openscreen", ["help"], { timeoutMs: 30_000 }).catch(() => null);
    const ok = !!h && h.code === 0 && h.stdout.includes("openscreen export");
    add({ name: "openscreen CLI", ok, detail: ok ? "export/record/captions available" : "help output not recognized", fix: ok ? undefined : `update OpenScreen (verified with ${OPENSCREEN_VERIFIED})` });
  }
  return checks;
}
