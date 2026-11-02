import { expect, test } from "bun:test";
import { centerOf, compileAnnotations, compileIdleSpeedups, compileZooms, synthesizeCursor } from "./compile.ts";
import { validateEvents } from "./validate.ts";
import type { ActionEvent } from "./types.ts";

const click = (tMs: number, cx: number, cy: number, extra: Partial<ActionEvent> = {}): ActionEvent => ({
  tMs, kind: "click", point: { cx, cy }, rect: { x: cx - 0.02, y: cy - 0.02, w: 0.04, h: 0.04 }, ...extra,
});

test("nearby actions merge into one zoom, distant ones split without overlap", () => {
  const z = compileZooms([click(1000, 0.2, 0.2), click(2000, 0.25, 0.22), click(3000, 0.9, 0.9)], 10_000);
  expect(z).toHaveLength(2);
  expect(z[0]!.startMs).toBe(500);
  expect(z[0]!.endMs).toBeLessThanOrEqual(z[1]!.startMs);
  for (const r of z) expect(r.endMs).toBeGreaterThan(r.startMs);
});

test("zoom regions are clamped to the video and honor zoom:false", () => {
  const z = compileZooms([click(100, 0.5, 0.5), click(9900, 0.1, 0.1, { zoom: false })], 10_000);
  expect(z).toHaveLength(1);
  expect(z[0]!.startMs).toBe(0);
  expect(compileZooms([click(100, 0.5, 0.5)], 10_000, { enabled: false })).toEqual([]);
});

test("captions run until the next caption and redactions become blur regions", () => {
  const a = compileAnnotations(
    [click(1000, 0.5, 0.5, { caption: "one" }), click(3000, 0.5, 0.5, { caption: "two", redact: true })],
    6000,
    {},
  );
  const caps = a.filter((r) => String(r.id).startsWith("agent-caption"));
  expect(caps.map((c) => c.content)).toEqual(["one", "two"]);
  expect(caps[0]!.endMs).toBeLessThan(3000);
  expect(a.filter((r) => r.type === "blur")).toHaveLength(1);
});

test("idle gaps become speed regions only when enabled", () => {
  const ev = [click(1000, 0.5, 0.5), click(12_000, 0.5, 0.5)];
  expect(compileIdleSpeedups(ev, 13_000, {})).toEqual([]);
  const s = compileIdleSpeedups(ev, 13_000, { idleSpeedupMs: 3000 });
  expect(s).toHaveLength(1);
  expect(s[0]).toMatchObject({ startMs: 2200, endMs: 11_400, speed: 4 });
});

test("synthetic cursor reaches each target and clicks on time", () => {
  const c = synthesizeCursor([click(1000, 0.2, 0.3), click(2500, 0.8, 0.7)], 4000);
  const clicks = c.samples.filter((s) => s.interactionType === "click");
  expect(clicks.map((s) => s.timeMs)).toEqual([1000, 2500]);
  expect(clicks[1]).toMatchObject({ cx: 0.8, cy: 0.7 });
  const times = c.samples.map((s) => s.timeMs);
  expect([...times].sort((a, b) => a - b)).toEqual(times);
  expect(times.at(-1)!).toBeGreaterThanOrEqual(3980);
});

test("unsorted, out-of-range and back-to-back events stay consistent", () => {
  const ev = [click(3000, 0.9, 0.9, { caption: "b" }), click(1000, 0.1, 0.1, { caption: "a" }), click(1050, 0.1, 0.1, { caption: "a2" }), click(99_000, 0.5, 0.5)];
  const z = compileZooms(ev, 5000);
  for (let i = 0; i < z.length; i++) {
    expect(z[i]!.endMs).toBeGreaterThan(z[i]!.startMs);
    if (i) expect(z[i]!.startMs).toBeGreaterThanOrEqual(z[i - 1]!.endMs);
    expect(z[i]!.endMs).toBeLessThanOrEqual(5000);
  }
  const caps = compileAnnotations(ev, 5000, {}).filter((r) => String(r.id).startsWith("agent-caption"));
  for (let i = 1; i < caps.length; i++) expect(caps[i]!.startMs).toBeGreaterThanOrEqual(caps[i - 1]!.endMs);
  const times = synthesizeCursor(ev, 5000).samples.map((s) => s.timeMs);
  expect([...times].sort((a, b) => a - b)).toEqual(times);
  for (const s of compileIdleSpeedups(ev, 5000, { idleSpeedupMs: 500 })) expect(s.endMs).toBeLessThanOrEqual(5000);
});

test("centerOf keeps a partly visible element's action point inside the frame", () => {
  // Top 60% of the element is above the viewport: the point is the middle of the visible 40%.
  const p = centerOf({ x: 0.4, y: -0.12, w: 0.2, h: 0.2 })!;
  expect(p.cx).toBeCloseTo(0.5);
  expect(p.cy).toBeCloseTo(0.04);
  // Fully inside: the plain center.
  expect(centerOf({ x: 0.1, y: 0.2, w: 0.2, h: 0.4 })).toEqual({ cx: 0.2, cy: 0.4 });
  // Wholly outside a desktop window (a separate dialog): no point, so no zoom or cursor.
  expect(centerOf({ x: 1.05, y: 0.3, w: 0.2, h: 0.1 })).toBeUndefined();
  // events.json built from it passes the check render runs (an unclamped center would not).
  expect(validateEvents([{ tMs: 0, kind: "click", point: p }], "e").filter((i) => i.level === "error")).toEqual([]);
  expect(validateEvents([{ tMs: 0, kind: "click", point: { cx: 0.5, cy: -0.02 } }], "e").some((i) => i.level === "error")).toBe(true);
});
