// Read-only preflight: are the tools installed and permitted? Never opens a GUI.

import { run } from "./exec.ts";

export type Check = { name: string; ok: boolean; detail: string; fix?: string };

async function which(cmd: string): Promise<string | null> {
  const r = await run("which", [cmd]).catch(() => null);
  return r && r.code === 0 ? r.stdout.trim() : null;
}

export async function doctor(): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  for (const [cmd, fix] of [
    ["ffmpeg", "brew install ffmpeg"],
    ["ffprobe", "brew install ffmpeg"],
    ["agent-browser", "npm i -g agent-browser"],
    ["agent-desktop", "npm i -g agent-desktop"],
    ["openscreen", "install OpenScreen 1.13+ and put its CLI on PATH"],
  ] as const) {
    const path = await which(cmd);
    add({ name: cmd, ok: !!path, detail: path ?? "not found", fix: path ? undefined : fix });
  }

  if (checks.find((c) => c.name === "agent-browser")?.ok) {
    const r = await run("agent-browser", ["--version"]);
    add({ name: "agent-browser version", ok: r.code === 0, detail: r.stdout.trim() });
  }
  if (checks.find((c) => c.name === "agent-desktop")?.ok) {
    const v = await run("agent-desktop", ["version"]);
    add({ name: "agent-desktop version", ok: v.code === 0, detail: v.stdout.match(/"version":"([^"]+)"/)?.[1] ?? v.stdout.trim() });
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
    add({ name: "openscreen CLI", ok, detail: ok ? "export/record/captions available" : "help output not recognized", fix: ok ? undefined : "update OpenScreen to 1.13+" });
  }
  return checks;
}
