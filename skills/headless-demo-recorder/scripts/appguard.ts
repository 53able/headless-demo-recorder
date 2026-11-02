// Which app a desktop capture may send input to. Pure functions; desktop.ts supplies the
// `lsappinfo` output for the target window's pid.

/** Always refused, even when listed in --allow-app (browsers, shells, system apps). Prefix match. */
export const DENY_PREFIXES = [
  "com.google.Chrome", // includes PWA shims com.google.Chrome.app.*
  "com.apple.Safari",
  "com.microsoft.edgemac",
  "org.mozilla.",
  "com.apple.Terminal",
  "com.apple.finder",
  "com.apple.systempreferences",
];

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
  if (allowApps && !allowApps.includes(bundleId)) return `${bundleId} is not in --allow-app (${allowApps.join(", ") || "none"})`;
  return undefined;
}
