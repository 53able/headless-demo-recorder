// Which app a desktop capture may send input to. Pure functions; desktop.ts supplies the
// `lsappinfo` output for the target window's pid, the app's window list and the process tree.

/** Always refused, even when listed in --allow-app (browsers, system apps). Prefix match. */
export const DENY_PREFIXES = [
  "com.google.Chrome", // includes PWA shims com.google.Chrome.app.*
  "com.apple.Safari",
  "com.microsoft.edgemac",
  "org.mozilla.",
  "com.apple.finder",
  "com.apple.systempreferences",
];

/** Shells: refused unless the exact bundle ID is in --allow-app. Prefix match. Typed text runs as
 * commands, which the destructive-step check (it reads target names only) does not see. */
export const OPT_IN_PREFIXES = ["com.apple.Terminal"];

export const requiresOptIn = (bundleId: string) => OPT_IN_PREFIXES.some((p) => bundleId.startsWith(p));

/** Extract `bundleID="…"` from `lsappinfo info -only bundleid <pid>`. For an unknown pid
 * lsappinfo prints nothing and exits 0, so undefined here means "refuse". */
export function parseBundleId(lsappinfoOutput: string): string | undefined {
  const m = lsappinfoOutput.match(/"?bundleID"?\s*=\s*"([^"]*)"/i);
  const id = m?.[1]?.trim();
  return id ? id : undefined;
}

/** Reason to refuse input to this bundle, or undefined when allowed. */
export function bundleRefusal(bundleId: string | undefined, allowApps?: string[]): string | undefined {
  if (!bundleId) return "cannot determine the target window's bundle ID (fail closed)";
  const denied = DENY_PREFIXES.find((p) => bundleId.startsWith(p));
  if (denied) return `${bundleId} is on the deny list (${denied}*)`;
  if (requiresOptIn(bundleId) && !allowApps?.includes(bundleId)) return `${bundleId} requires an explicit --allow-app ${bundleId}`;
  if (allowApps && !allowApps.includes(bundleId)) return `${bundleId} is not in --allow-app (${allowApps.join(", ") || "none"})`;
  return undefined;
}

/** Clients that carry a shell from elsewhere: keys typed into them can reach a session (the agent's
 * own, say) that does not run under the recorded app. Matched against the executable's base name. */
export const SHARED_SESSION_CLIENTS = ["tmux", "screen", "zellij", "byobu", "abduco", "dtach", "ssh", "mosh-client", "et"];

export type ProcRow = { pid: number; ppid: number; comm: string };

/** Rows of `ps -A -o pid=,ppid=,comm=` (comm may contain spaces). */
export function parsePs(out: string): ProcRow[] {
  return out.split("\n").flatMap((line) => {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), comm: m[3]! }] : [];
  });
}

/** `pid` and its ancestors up to launchd; undefined when the walk cannot finish (a process missing
 * from the table, or a cycle), which callers treat as "may run inside anything". */
export function ancestorsOf(rows: ProcRow[], pid: number): number[] | undefined {
  const parent = new Map(rows.map((r) => [r.pid, r.ppid]));
  const chain: number[] = [];
  for (let p = pid, i = 0; i < 256; i++) {
    chain.push(p);
    if (p <= 1) return chain;
    const next = parent.get(p);
    if (next === undefined) return undefined;
    p = next;
  }
  return undefined;
}

/** Whether the launcher runs inside the app process `appPid`. `given`: the launcher's ancestors
 * (a session server's, from `session start`), null when unknown; undefined: use `ownPid`'s own.
 * undefined result: unknown. */
export function launcherRunsInside(given: number[] | null | undefined, rows: ProcRow[], ownPid: number, appPid: number): boolean | undefined {
  const chain = given === undefined ? ancestorsOf(rows, ownPid) : given ?? undefined;
  return chain?.includes(appPid);
}

/** The first shared-session client running under `root`, if any. */
export function sharedSessionUnder(rows: ProcRow[], root: number): string | undefined {
  const kids = new Map<number, ProcRow[]>();
  for (const r of rows) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r]);
  const seen = new Set<number>();
  const queue = [...(kids.get(root) ?? [])];
  while (queue.length) {
    const r = queue.shift()!;
    if (seen.has(r.pid)) continue;
    seen.add(r.pid);
    const name = r.comm.split("/").pop()!.replace(/^-/, "").split(" ")[0]!;
    if (SHARED_SESSION_CLIENTS.includes(name)) return name;
    queue.push(...(kids.get(r.pid) ?? []));
  }
  return undefined;
}

/** Extra conditions for an opt-in app (a shell), or undefined when they hold. `press` reaches the
 * app's key window, not a chosen one, so the recorded window must be the app's only window. The
 * agent's own shell must be out of reach: this CLI must not run inside the app (undefined: unknown,
 * so refused), and no tmux/ssh-like client may run in it, since it could be attached to the agent's session. */
export function optInRefusal(bundleId: string, o: { windowIds: string[]; recordedId: string; cliRunsInside: boolean | undefined; sharedSession?: string }): string | undefined {
  if (o.cliRunsInside !== false) {
    return o.cliRunsInside ? `this CLI runs inside ${bundleId}; run the agent from another app to record it`
      : `cannot tell whether this CLI runs inside ${bundleId} (fail closed)`;
  }
  if (o.sharedSession) return `${o.sharedSession} runs inside ${bundleId}; it may carry another session (the agent's own), so quit it first`;
  if (!o.windowIds.includes(o.recordedId)) return `the recorded window of ${bundleId} is gone`;
  if (o.windowIds.length !== 1) {
    return `${bundleId} has ${o.windowIds.length} windows; keys could reach one that is not recorded, so close all but the recorded window`;
  }
  return undefined;
}
