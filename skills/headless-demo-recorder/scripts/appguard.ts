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

/** `stat` holds "+" for a process in its terminal's foreground process group. */
export type ProcRow = { pid: number; ppid: number; stat: string; comm: string };

/** Rows of `ps -A -o pid=,ppid=,stat=,comm=` (comm may contain spaces). */
export function parsePs(out: string): ProcRow[] {
  return out.split("\n").flatMap((line) => {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), stat: m[3]!, comm: m[4]! }] : [];
  });
}

const baseName = (comm: string) => comm.split("/").pop()!.replace(/^-/, "").split(" ")[0]!;

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

/** Processes started directly by the app: a terminal app starts one (`login`, or the shell) per tab or
 * window. Windows on another Space and background tabs are missing from the window list but not here. */
export const sessionsUnder = (rows: ProcRow[], root: number) => rows.filter((r) => r.ppid === root).length;

/** Shells a terminal session may start in. Anything else at the top of a session is refused. */
export const SHELLS = ["zsh", "bash", "sh", "dash", "ksh", "mksh", "tcsh", "csh", "fish", "nu", "xonsh"];

/** What keeps a terminal app's session from waiting at a shell prompt, if anything: the program at the
 * top of a session (a child of `root`, or of its `login`) when it is not a shell (`exec claude`, a
 * profile's startup command, "New Command"), or a foreground ("+") process under `root` other than
 * that shell. Measured: an idle shell is "S+"; while it runs a command the shell is "S" and the command "S+". */
export function foregroundUnder(rows: ProcRow[], root: number): string | undefined {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const under = (r: ProcRow): boolean => {
    for (let p = r.ppid, i = 0; i < 256 && p > 1; p = byPid.get(p)?.ppid ?? 0, i++) if (p === root) return true;
    return false;
  };
  const isLogin = (r: ProcRow | undefined) => !!r && r.ppid === root && baseName(r.comm) === "login";
  const tops = rows.filter((r) => (r.ppid === root && !isLogin(r)) || isLogin(byPid.get(r.ppid)));
  const notShell = tops.find((r) => !SHELLS.includes(baseName(r.comm)));
  if (notShell) return baseName(notShell.comm);
  const busy = rows.find((r) => r.stat.includes("+") && under(r) && !tops.includes(r) && !isLogin(r));
  return busy && baseName(busy.comm);
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
    const name = baseName(r.comm);
    if (SHARED_SESSION_CLIENTS.includes(name)) return name;
    queue.push(...(kids.get(r.pid) ?? []));
  }
  return undefined;
}

/** Extra conditions for an opt-in app (a shell), or undefined when they hold. `press` reaches the
 * app's key window, not a chosen one, so the recorded window must be the app's only window. The
 * agent's own shell must be out of reach: this CLI must not run inside the app (undefined: unknown,
 * so refused), no tmux/ssh-like client may run in it, since it could be attached to the agent's session,
 * and it must run one terminal session only (`sessionsUnder`): tabs share a window. */
export function optInRefusal(bundleId: string, o: { windowIds: string[]; recordedId: string; cliRunsInside: boolean | undefined; sharedSession?: string; sessions?: number; foreground?: string }): string | undefined {
  if (o.cliRunsInside !== false) {
    return o.cliRunsInside ? `this CLI runs inside ${bundleId}; run the agent from another app to record it`
      : `cannot tell whether this CLI runs inside ${bundleId} (fail closed)`;
  }
  if (o.sharedSession) return `${o.sharedSession} runs inside ${bundleId}; it may carry another session (the agent's own), so quit it first`;
  // Before recording: the session must wait at its shell prompt, not run a program (another agent, say)
  // that would take the keys. Later inputs may drive what the demo itself started.
  if (o.foreground) return `${bundleId} is running ${o.foreground} in the foreground; ask the user to return it to an idle shell prompt before recording`;
  // Keys go to the front tab of the key window: another tab (the agent, another agent) could take them.
  if (o.sessions !== undefined && o.sessions !== 1) {
    return `${bundleId} runs ${o.sessions} terminal sessions (tabs or windows); keys could reach one that is not recorded, so keep only the recorded one`;
  }
  return soleWindowRefusal(bundleId, o.windowIds, o.recordedId);
}

export type WindowInfo = { id: string; pid?: number; visible: boolean; accessible?: boolean; bounds: { x: number; y: number; width: number; height: number } };

/** Windows of the recorded process that could hold the keyboard. A small overlay drawn inside the
 * recorded window with no accessibility element (a tooltip-like panel Calculator shows while it is
 * operated, measured) cannot, so it is left out: visible, `accessible: false`, inside the recorded
 * window's current bounds, at most a quarter of its area. Hidden windows and windows elsewhere still
 * count; so do windows whose pid is unknown, unless they are such an overlay. Opt-in apps (shells) do not use this: they count every window. */
export function keyWindowCandidates(windows: WindowInfo[], recordedId: string, pid: number | undefined): string[] {
  const own = windows.filter((w) => w.pid === undefined || w.pid === pid);
  const r = own.find((w) => w.id === recordedId)?.bounds;
  if (!r) return own.map((w) => w.id); // the recorded window is gone: exclude nothing
  const overlay = (w: WindowInfo) => {
    const b = w.bounds;
    const inside = b.x >= r.x && b.y >= r.y && b.x + b.width <= r.x + r.width && b.y + b.height <= r.y + r.height;
    return w.visible && w.accessible === false && inside && b.width * b.height <= (r.width * r.height) / 4;
  };
  return own.filter((w) => w.id === recordedId || !overlay(w)).map((w) => w.id);
}

/** `press` sends keys to the app's key window, which agent-desktop cannot name or choose: they are
 * known to reach the recorded window only while it is the app's only window. Undefined when it is. */
export function soleWindowRefusal(app: string, windowIds: string[], recordedId: string): string | undefined {
  if (!windowIds.includes(recordedId)) return `the recorded window of ${app} is gone`;
  if (windowIds.length !== 1) {
    return `${app} has ${windowIds.length} windows; keys go to its key window, which may not be the recorded one, so close all but the recorded window`;
  }
  return undefined;
}
