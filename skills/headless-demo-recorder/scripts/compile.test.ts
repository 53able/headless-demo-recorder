import { expect, test } from "bun:test";
import { MARKER_HOLD_MS, MARKER_LEAD_MS, centerOf, compileAnnotations, compileEditor, compileMarkers, ringPngBytes, compileIdleSpeedups, compileZooms, synthesizeCursor } from "./compile.ts";
import { inflateSync } from "node:zlib";
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

const markers = (ev: ActionEvent[], durationMs = 20_000) => compileEditor({ videoPath: "v.mp4", width: 1280, height: 720, durationMs, events: ev, realCursor: false }, {}).markers;

test("one marker per click/type with a point; press, scroll, mark, redact and point-less events get none", () => {
  const ev: ActionEvent[] = [
    click(1000, 0.2, 0.2),
    { tMs: 3000, kind: "type", point: { cx: 0.5, cy: 0.5 }, rect: { x: 0.45, y: 0.48, w: 0.1, h: 0.04 } },
    { tMs: 5000, kind: "press", point: { cx: 0.5, cy: 0.5 } },
    { tMs: 6000, kind: "scroll", point: { cx: 0.5, cy: 0.5 } },
    { tMs: 7000, kind: "mark", point: { cx: 0.5, cy: 0.5 } },
    click(8000, 0.5, 0.5, { redact: true }),
    { tMs: 9000, kind: "click" },
  ];
  const m = markers(ev);
  expect(m).toHaveLength(2);
  expect(m[0]).toMatchObject({ startMs: 1000 - MARKER_LEAD_MS, endMs: 1000 + MARKER_HOLD_MS });
  const patch = compileEditor({ videoPath: "v.mp4", width: 1, height: 1, durationMs: 20_000, events: ev, realCursor: false }, {});
  expect(patch.annotationRegions.some((a) => String(a.id).includes("marker"))).toBe(false);
});

test("marker: rect off the frame is cut to the visible part; tiny edge elements are widened and shifted inside", () => {
  const [a] = markers([click(1000, 0.5, 0.1, { rect: { x: 0.4, y: -0.1, w: 0.2, h: 0.2 } })]);
  expect(a!.box.x).toBeCloseTo(0.4); expect(a!.box.y).toBeCloseTo(0); expect(a!.box.w).toBeCloseTo(0.2); expect(a!.box.h).toBeCloseTo(0.1);
  const [c] = markers([click(1000, 0.99, 0.5, { rect: { x: 0.99, y: 0.5, w: 0.005, h: 0.005 } })]);
  expect(c!.box.w).toBeCloseTo(0.04); expect(c!.box.h).toBeCloseTo(0.04);
  expect(c!.box.x + c!.box.w).toBeLessThanOrEqual(1 + 1e-9);
  expect(c!.box.x).toBeGreaterThanOrEqual(0); expect(c!.box.y).toBeGreaterThanOrEqual(0);
});

test("marker: point-only events get a 0.06 box; page-sized rects get none", () => {
  const [a] = markers([{ tMs: 1000, kind: "click", point: { cx: 0.5, cy: 0.5 } }]);
  expect(a!.box.w).toBeCloseTo(0.06); expect(a!.box.h).toBeCloseTo(0.06);
  expect(markers([click(1000, 0.5, 0.5, { rect: { x: 0, y: 0, w: 0.6, h: 0.5 } })])).toEqual([]);
});

test("markers stay inside the video, end before the next one, and are at least 300ms", () => {
  const ev = [click(100, 0.2, 0.2), click(600, 0.4, 0.4), click(650, 0.6, 0.6), click(9900, 0.8, 0.8)];
  const m = compileMarkers(ev, 10_000);
  // The 600ms click (next starts 50ms later) and the 9900ms click (250ms left) are dropped.
  expect(m).toHaveLength(2);
  m.forEach((r, i) => {
    expect(r.startMs).toBeGreaterThanOrEqual(0);
    expect(r.endMs).toBeLessThanOrEqual(10_000);
    expect(r.endMs - r.startMs).toBeGreaterThanOrEqual(300);
    if (i) expect(r.startMs).toBeGreaterThan(m[i - 1]!.endMs);
  });
});

test("edit.marker:false turns markers off", () => {
  expect(markers([click(1000, 0.5, 0.5)])).toHaveLength(1);
  const off = compileEditor({ videoPath: "v.mp4", width: 1, height: 1, durationMs: 5000, events: [click(1000, 0.5, 0.5)], realCursor: false }, { marker: false });
  expect(off.markers).toEqual([]);
});

test("ringPngBytes: valid PNG header, matching size, transparent inside, opaque on the edge", () => {
  const png = ringPngBytes(100, 60);
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(png.readUInt32BE(16)).toBe(100);
  expect(png.readUInt32BE(20)).toBe(60);
  // Single IDAT chunk: 8 sig + 25 IHDR, then length(4) "IDAT" data.
  const len = png.readUInt32BE(33);
  const raw = inflateSync(png.subarray(41, 41 + len));
  const alpha = (x: number, y: number) => raw[y * (100 * 4 + 1) + 1 + x * 4 + 3]!;
  expect(alpha(50, 30)).toBe(0);
  expect(alpha(50, 1)).toBe(255);
  expect(alpha(1, 30)).toBe(255);
  expect(alpha(0, 0)).toBe(0);
});
