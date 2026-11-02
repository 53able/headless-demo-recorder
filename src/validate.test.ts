import { expect, test } from "bun:test";
import { validateEvents, validateScenario } from "./validate.ts";

const base = { name: "demo", source: { type: "browser", url: "https://example.com" }, output: { path: "out/demo.mp4" } };
const errors = (s: unknown) => validateScenario(s).filter((i) => i.level === "error").map((i) => i.path);

test("a minimal browser scenario is valid", () => {
  expect(errors(base)).toEqual([]);
});

test("irreversible-looking steps need allowDestructive", () => {
  const s = { ...base, steps: [{ action: "click", target: "text=Delete account" }, { action: "click", target: "button:has-text(\"送信\")" }] };
  expect(errors(s)).toEqual(["steps[0]", "steps[1]"]);
  expect(errors({ ...s, allowDestructive: true })).toEqual([]);
  // A per-step acknowledgement clears only that step.
  const acked = { ...s, steps: [{ ...s.steps[0], allowDestructive: true }, s.steps[1]] };
  expect(errors(acked)).toEqual(["steps[1]"]);
});

test("source-specific mistakes are reported with their path", () => {
  expect(errors({ ...base, steps: [{ action: "click", target: "@e3" }] })).toEqual(["steps[0].target"]);
  expect(errors({ ...base, source: { type: "desktop", app: "Notes" }, steps: [{ action: "scroll" }] })).toEqual(["steps[0].action"]);
  expect(errors({ ...base, output: { path: "out/demo.mov" } })).toEqual(["output.path"]);
  expect(errors({ ...base, steps: [{ action: "fill", target: "#q" }] })).toEqual(["steps[0].value"]);
});

const urlErrors = (s: unknown, opts?: Parameters<typeof validateScenario>[1]) =>
  validateScenario(s, opts).filter((i) => i.level === "error").map((i) => i.path);

test("every URL must be http(s)", () => {
  for (const url of ["file:///etc/passwd", "chrome://settings", "javascript:alert(1)", "ftp://example.com", "not a url"]) {
    expect(urlErrors({ ...base, source: { type: "browser", url } })).toEqual(["source.url"]);
    expect(urlErrors({ ...base, steps: [{ action: "open", url }] })).toEqual(["steps[0].url"]);
  }
});

test("allowOrigins matches scheme, host and port", () => {
  const opts = { allowOrigins: ["https://example.com", "http://127.0.0.1:4173"] };
  expect(urlErrors(base, opts)).toEqual([]);
  // Default ports are normalized on both sides.
  expect(urlErrors({ ...base, source: { type: "browser", url: "https://example.com:443/a?b" } }, opts)).toEqual([]);
  expect(urlErrors({ ...base, source: { type: "browser", url: "http://127.0.0.1:4173/" } }, opts)).toEqual([]);
  expect(urlErrors({ ...base, source: { type: "browser", url: "https://evil.example.org" } }, opts)).toEqual(["source.url"]);
  expect(urlErrors({ ...base, source: { type: "browser", url: "http://example.com" } }, opts)).toEqual(["source.url"]);
  expect(urlErrors({ ...base, source: { type: "browser", url: "http://127.0.0.1:8080" } }, opts)).toEqual(["source.url"]);
  expect(urlErrors({ ...base, steps: [{ action: "open", url: "https://example.com.evil.org/" }] }, opts)).toEqual(["steps[0].url"]);
  // An empty allowlist allows nothing; a malformed entry is itself an error.
  expect(urlErrors(base, { allowOrigins: [] })).toEqual(["source.url"]);
  expect(urlErrors(base, { allowOrigins: ["example.com"] })).toEqual(["allowOrigins", "source.url"]);
});

test("desktop string refs, trims and idle speed-ups are allowed by default", () => {
  const desk = { ...base, source: { type: "desktop", app: "Calculator" }, steps: [{ action: "click", target: "@e1" }, { action: "click", target: { role: "button", name: "1" } }] };
  expect(urlErrors(desk)).toEqual([]);
  expect(urlErrors({ ...base, edit: { trim: [{ startMs: 0, endMs: 100 }], idleSpeedupMs: 1500 } })).toEqual([]);
});

test("events files must use {cx, cy} points and {x, y, w, h} rects", () => {
  const ok = [{ tMs: 0, kind: "click", point: { cx: 0.5, cy: 0.5 }, rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, caption: "why", zoom: false, redact: true }, { tMs: 10, kind: "mark" }];
  expect(validateEvents(ok)).toEqual([]);
  const bad = [{ tMs: -1, kind: "tap", point: { x: 0.5, y: 0.5 }, rect: { x: 0, y: 0 }, caption: 3, zoom: "false" }];
  expect(validateEvents(bad).map((i) => i.path)).toEqual(["events[0].tMs", "events[0].kind", "events[0].point", "events[0].rect", "events[0].caption", "events[0].zoom"]);
  expect(validateEvents({}).map((i) => i.path)).toEqual(["events"]);
});

test("pixel points are errors; off-frame rects and rect-less redaction are warnings", () => {
  const issues = validateEvents([
    { tMs: 0, kind: "click", point: { cx: 640, cy: 360 } },
    { tMs: 1, kind: "type", rect: { x: 0.9, y: 0.5, w: 0.2, h: 0.1 } },
    { tMs: 2, kind: "type", redact: true },
  ]);
  expect(issues.map((i) => [i.path, i.level])).toEqual([["events[0].point", "error"], ["events[1].rect", "warning"], ["events[2].redact", "warning"]]);
});
