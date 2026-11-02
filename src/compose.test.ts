import { expect, test } from "bun:test";
import { compileEditor, type ZoomRegion } from "./compile.ts";
import { alignLeadMs, composeEditor, compositeArgs, fitRect, planScenes, resolveZoomConflicts, type AlignedCapture } from "./compose.ts";
import type { ActionEvent, Composition } from "./types.ts";

const click = (tMs: number, cx: number, cy: number, extra: Partial<ActionEvent> = {}): ActionEvent => ({
  tMs, kind: "click", point: { cx, cy }, rect: { x: cx - 0.02, y: cy - 0.02, w: 0.04, h: 0.04 }, ...extra,
});
const cap = (width: number, height: number, durationMs: number, events: ActionEvent[], t0EpochMs?: number): AlignedCapture => ({
  videoPath: "x.mp4", width, height, durationMs, events, realCursor: false, ...(t0EpochMs !== undefined && { t0EpochMs }),
});
const comp = (scenes: Composition["scenes"], edit?: Composition["edit"]): Composition => ({ name: "c", scenarios: ["a.json", "b.json"], scenes, edit, output: { path: "out/c.mp4" } });
const zoom = (startMs: number, endMs: number, cx: number): ZoomRegion => ({ id: "z", startMs, endMs, depth: 3, focus: { cx, cy: 0.5 }, focusMode: "manual", source: "manual" });

test("fitRect letterboxes to integer, even sizes", () => {
  expect(fitRect(230, 408, { w: 960, h: 1080 })).toEqual({ x: 176, y: 0, w: 608, h: 1080 });
  expect(fitRect(1280, 800, { w: 1920, h: 1080 })).toEqual({ x: 96, y: 0, w: 1728, h: 1080 });
  for (const r of [fitRect(230, 408, { w: 960, h: 1080 }), fitRect(1280, 800, { w: 960, h: 1080 })]) {
    expect(r.w % 2 + r.h % 2).toBe(0);
    for (const v of Object.values(r)) expect(Number.isInteger(v)).toBe(true);
  }
});

test("alignLeadMs measures each start against the latest; missing t0 is 0", () => {
  expect(alignLeadMs({ a: cap(10, 10, 1000, [], 1000), b: cap(10, 10, 1000, [], 1300) })).toEqual({ a: 300, b: 0 });
  expect(alignLeadMs({ a: cap(10, 10, 1000, []), b: cap(10, 10, 1000, []) })).toEqual({ a: 0, b: 0 });
});

test("segment-local time subtracts start and lead", () => {
  const caps = { a: cap(1920, 1080, 10_000, [click(2300, 0.5, 0.5, { caption: "why" })], 1000), b: cap(1920, 1080, 10_000, [], 1300) };
  const c = comp([{ layout: "single", streams: [{ scenario: "a", startMs: 1000 }] }]);
  const [sc] = planScenes(c, caps);
  expect(sc!.streams[0]).toMatchObject({ start: 1000, end: 9700, lead: 300 });
  const { events, patch } = composeEditor(c, caps, {});
  expect(events.find((e) => e.kind === "click")!.tMs).toBe(1000);
  expect(patch.annotationRegions.find((a) => a.type === "text")!.startMs).toBe(800);
});

test("scene length is the longest stream; the shorter one is padded", () => {
  const caps = { a: cap(1920, 1080, 4000, []), b: cap(1920, 1080, 6000, []) };
  const s = planScenes(comp([{ layout: "side-by-side", streams: [{ scenario: "a" }, { scenario: "b" }] }, { layout: "single", streams: [{ scenario: "a" }] }]), caps);
  expect(s.map((x) => [x.offsetMs, x.lengthMs])).toEqual([[0, 6000], [6000, 4000]]);
  expect(s[0]!.streams.map((x) => x.padMs)).toEqual([2000, 0]);
});

test("resolveZoomConflicts keeps the first of overlapping zooms and prefers the left cell on ties", () => {
  expect(resolveZoomConflicts([zoom(3000, 4000, 0.7), zoom(0, 1000, 0.2)]).map((z) => [z.id, z.startMs])).toEqual([["agent-zoom-1", 0], ["agent-zoom-2", 3000]]);
  expect(resolveZoomConflicts([zoom(0, 2000, 0.2), zoom(1500, 3000, 0.7)]).map((z) => z.startMs)).toEqual([0]);
  expect(resolveZoomConflicts([zoom(500, 2000, 0.7), zoom(500, 2000, 0.2)]).map((z) => z.focus.cx)).toEqual([0.2]);
});

test("AC-7: a single full-frame scene matches compileEditor", () => {
  const ev = [click(1000, 0.2, 0.3, { caption: "one" }), click(3000, 0.8, 0.7, { caption: "two", redact: true }), click(3500, 0.82, 0.72)];
  const a = cap(1920, 1080, 8000, ev);
  const edit = { zoom: { depth: 2 as const }, captionFontSize: 50 };
  const want = compileEditor(a, edit);
  const got = composeEditor(comp([{ layout: "single", streams: [{ scenario: "a" }] }]), { a }, { a: edit });
  expect(got.patch.zoomRegions).toEqual(want.zoomRegions);
  expect(got.patch.annotationRegions.map((r) => ({ ...r, id: String(r.id).replace(/^s1-1-/, "") }))).toEqual(want.annotationRegions);
  expect(got.events).toEqual([{ tMs: 0, kind: "mark", label: "scene 1: single" }, ...ev]);
});

test("side-by-side: right-cell captions and points land in the right half", () => {
  const caps = { a: cap(230, 408, 5000, [click(1000, 0.5, 0.5, { caption: "left" })]), b: cap(1280, 800, 5000, [click(1000, 0.5, 0.5, { caption: "right" })]) };
  const { patch, events } = composeEditor(comp([{ layout: "side-by-side", streams: [{ scenario: "a" }, { scenario: "b" }] }]), caps, {});
  const right = patch.annotationRegions.find((r) => r.content === "right") as unknown as { position: { x: number }; size: { width: number }; style: { fontSize: number } };
  expect(right.position.x).toBeGreaterThanOrEqual(50);
  expect(right.position.x + right.size.width).toBeLessThanOrEqual(100);
  expect(right.style.fontSize).toBe(38);
  const pts = events.filter((e) => e.point).map((e) => e.point!.cx).sort();
  expect(pts[0]!).toBeLessThan(0.5);
  expect(pts[1]!).toBeGreaterThan(0.5);
  // Both clicks start a zoom at the same time; only the left one survives.
  expect(patch.zoomRegions).toHaveLength(1);
  expect(patch.zoomRegions[0]!.focus.cx).toBeLessThan(0.5);
});

test("compositeArgs: one input per scene stream, hstack per side-by-side, one concat", () => {
  const caps = { a: cap(230, 408, 4000, []), b: cap(1280, 800, 6000, []) };
  const plan = planScenes(comp([{ layout: "side-by-side", streams: [{ scenario: "a" }, { scenario: "b" }] }, { layout: "single", streams: [{ scenario: "b", startMs: 1000, endMs: 3000 }] }]), caps);
  const inputs = [{ path: "a.mp4", w: 230, h: 408 }, { path: "b.mp4", w: 1280, h: 800 }, { path: "b.mp4", w: 1280, h: 800 }];
  const args = compositeArgs(plan, inputs, [1920, 1080], "out.mp4");
  expect(args.filter((x) => x === "-i")).toHaveLength(3);
  const f = args[args.indexOf("-filter_complex") + 1]!;
  expect(f).toContain("[0:v]trim=start=0.000:end=4.000,setpts=PTS-STARTPTS,fps=30,scale=608:1080,pad=960:1080:176:0:color=0x111111,setsar=1,tpad=stop_mode=clone:stop_duration=2.000[v0]");
  expect(f).toContain("[2:v]trim=start=1.000:end=3.000");
  expect(f).toContain("scale=1728:1080,pad=1920:1080:96:0");
  expect(f).toContain("[v0][v1]hstack=inputs=2[sc0]");
  expect(f).toContain("[sc0][v2]concat=n=2:v=1:a=0[out]");
  expect(args.at(-1)).toBe("out.mp4");
});
