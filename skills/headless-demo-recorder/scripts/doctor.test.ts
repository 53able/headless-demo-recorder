import { expect, test } from "bun:test";
import { agentDesktopVersion, atLeast, latestCheck, TOOL_VERSIONS, versionCheck } from "./doctor.ts";

test("atLeast compares the first x.y.z in tool output", () => {
  expect(atLeast("agent-browser 0.41.1", "0.41.0")).toBe(true);
  expect(atLeast("agent-browser 0.40.0", "0.41.0")).toBe(false);
  expect(atLeast("1.0.2", "1.0.2")).toBe(true);
  expect(atLeast("0.100.0", "0.41.0")).toBe(true); // numeric, not lexical
  expect(atLeast("2.0.0", "10.0.0")).toBe(false);
  expect(atLeast("no version here", "0.0.1")).toBe(false);
});

test("versionCheck: older than min fails, newer than verified warns, unreadable fails without a downgrade", () => {
  const { min, verified } = TOOL_VERSIONS["agent-desktop"];
  const old = versionCheck("agent-desktop", true, "1.0.2");
  expect(old).toMatchObject({ ok: false, detail: "1.0.2" });
  expect(old.fix).toContain(`needs ${min}+`);
  const same = versionCheck("agent-desktop", true, verified);
  expect(same).toMatchObject({ ok: true });
  expect(same.warning).toBeUndefined();
  const newer = versionCheck("agent-desktop", true, "99.0.0");
  expect(newer).toMatchObject({ ok: true, detail: "99.0.0" });
  expect(newer.warning).toContain(`newer than ${verified}`);
  expect(versionCheck("agent-desktop", true, `${min}-beta.1`)).toMatchObject({ ok: false }); // before the minimum
  const pre = versionCheck("agent-desktop", true, "99.0.0-beta.1");
  expect(pre).toMatchObject({ ok: true, detail: "99.0.0-beta.1" });
  expect(pre.warning).toContain("prerelease");
  // A format it cannot read (a newer release, say) fails, shows the output, and never suggests a version.
  const unreadable = versionCheck("agent-desktop", true, "", `{"version":"3","data":{"version":"2.0"}}`);
  expect(unreadable).toMatchObject({ ok: false });
  expect(unreadable.fix).not.toContain("npm i");
  expect(unreadable.detail).toContain("2.0");
  expect(versionCheck("agent-browser", false, "")).toMatchObject({ ok: false });
  for (const v of Object.values(TOOL_VERSIONS)) expect(atLeast(v.verified, v.min)).toBe(true);
});

test("agent-desktop's version is data.version, not the envelope's version", () => {
  // Measured on agent-desktop 1.3.0.
  const out = `{"version":"2.6","ok":true,"command":"version","data":{"os":"macos","target":"aarch64","version":"1.3.0"}}`;
  expect(agentDesktopVersion(out)).toBe("1.3.0");
  expect(versionCheck("agent-desktop", true, agentDesktopVersion(out), out)).toMatchObject({ ok: true, detail: "1.3.0" });
  // The envelope's version is never taken for the tool's.
  expect(versionCheck("agent-desktop", true, agentDesktopVersion(`{"version":"2.6.0","data":{"tool_version":"1.0.2"}}`))).toMatchObject({ ok: false });
  expect(agentDesktopVersion("not json")).toBe("");
  expect(agentDesktopVersion(`{"version":"2.6","data":{}}`)).toBe("");
});

test("latestCheck: a release past verified, or ahead of the install, is always a warning, never a failure", () => {
  const { verified } = TOOL_VERSIONS["agent-desktop"];
  expect(latestCheck("agent-desktop", verified, verified)).toEqual({ name: "agent-desktop latest", ok: true, detail: verified });
  const ahead = latestCheck("agent-desktop", verified, "99.0.0");
  expect(ahead.ok).toBe(true);
  expect(ahead.warning).toContain(`checked with ${verified} only`);
  expect(ahead.warning).toContain(`${verified} is installed`);
  // Installed behind a latest that is still within verified: only the update hint.
  const behind = latestCheck("agent-browser", "0.41.0", TOOL_VERSIONS["agent-browser"].verified);
  expect(behind.warning).toContain("is installed");
  expect(behind.warning).not.toContain("checked with");
  expect(latestCheck("agent-desktop", "", verified).warning).toBeUndefined(); // unknown install: no update hint
});
