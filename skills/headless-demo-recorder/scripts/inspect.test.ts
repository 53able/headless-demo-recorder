import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportTimeMs, exportTimeline, frameTimes } from "./inspect.ts";

test("exportTimeMs: identity without regions, speed spans compress, trims remove", () => {
  expect(exportTimeMs(5000, {})).toBe(5000);
  // An idle gap 1964..9023 played 4x (a real session export: 15633ms capture -> ~10400ms GIF).
  const speed = { speedRegions: [{ startMs: 1964, endMs: 9023, speed: 4 }] };
  expect(exportTimeMs(1000, speed)).toBe(1000);
  expect(exportTimeMs(5000, speed)).toBe(1964 + (5000 - 1964) / 4);
  expect(exportTimeMs(9973, speed)).toBeCloseTo(9973 - 7059 * 0.75);
  expect(exportTimeMs(15633, speed)).toBeCloseTo(10338.75);
  // A trimmed span vanishes; a time inside it lands on the cut.
  const trim = { trimRegions: [{ startMs: 2000, endMs: 3000 }] };
  expect(exportTimeMs(2500, trim)).toBe(2000);
  expect(exportTimeMs(4000, trim)).toBe(3000);
  // Both at once, in either order in the timeline.
  expect(exportTimeMs(10000, { ...trim, speedRegions: [{ startMs: 5000, endMs: 7000, speed: 2 }] })).toBe(10000 - 1000 - 1000);
});

test("frameTimes: without regions the whole timeline is scaled, +350ms after the action, clamped to the end", () => {
  expect(frameTimes([1000], 10000, 10000)).toEqual({ tMs: [1350], ratio: 1 });
  // Export shorter than the capture: the ratio scales, and the frame stays inside the export.
  expect(frameTimes([1000], 10000, 5000).tMs).toEqual([675]);
  expect(frameTimes([9000], 10000, 5000).tMs).toEqual([4675]);
  // Export longer than the capture (ratio 2): the frame is clamped to 50ms before the end.
  expect(frameTimes([4900], 5000, 10000).tMs).toEqual([9950]);
});

test("frameTimes: with speed regions an action after the speed-up lands on the export's frame", () => {
  // A real session export: capture 15633ms, idle gap 1964..9023 at 4x, export 10338.75ms.
  const regions = { speedRegions: [{ startMs: 1964, endMs: 9023, speed: 4 }] };
  const exportMs = exportTimeMs(15633, regions);
  // Action at 5000 -> frame at capture 5350 -> 1964 + (5350 - 1964) / 4 = 2810.5 -> 2811.
  expect(frameTimes([5000], 15633, exportMs, regions)).toEqual({ tMs: [2811], ratio: 1 });
});

test("frameTimes: where speed regions overlap, the first in array order applies", () => {
  const regions = { speedRegions: [{ startMs: 0, endMs: 1000, speed: 2 }, { startMs: 500, endMs: 2000, speed: 4 }] };
  // Capture 3000 maps to 1750 under these regions; the action at 400 lands at capture 750 -> 375.
  expect(exportTimeMs(3000, regions)).toBe(1750);
  expect(frameTimes([400], 3000, 1750, regions).tMs).toEqual([375]);
});

test("frameTimes: a frame inside a trimmed span shows the cut", () => {
  const regions = { trimRegions: [{ startMs: 2000, endMs: 3000 }] };
  const exportMs = exportTimeMs(5000, regions);
  expect(exportMs).toBe(4000);
  // Action at 1700 -> capture 2050, inside the trim -> the cut at export 2000.
  expect(frameTimes([1700], 5000, exportMs, regions).tMs).toEqual([2000]);
});

test("exportTimeMs: a trim inside a speed span removes its part and the rest of the span stays sped up", () => {
  // speed 4000..8000 at 2x with 5000..6000 trimmed: 4000 + 1000/2 + 0 + 2000/2 + 2000 = 7500.
  const regions = { trimRegions: [{ startMs: 5000, endMs: 6000 }], speedRegions: [{ startMs: 4000, endMs: 8000, speed: 2 }] };
  expect(exportTimeMs(10000, regions)).toBe(7500);
  // A time inside the trim lands on the cut, after the sped-up part before it.
  expect(exportTimeMs(5500, regions)).toBe(4500);
});

test("exportTimeline: which render record inspect trusts, and when it falls back to the ratio", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hdr-inspect-"));
  try {
    const out = join(dir, "out.mp4");
    const speedRegions = [{ id: "s", startMs: 1000, endMs: 3000, speed: 4 }];
    const record = (r: object) => writeFile(join(dir, "render.json"), JSON.stringify({ outputPath: out, timelineEdited: true, timeline: { trimRegions: [], speedRegions }, ...r }));

    // The raw capture is never edited, whatever the record says.
    await record({});
    expect(await exportTimeline(dir, join(dir, "capture.mp4"))).toEqual({ edited: false });
    // The latest export: its regions are used.
    expect(await exportTimeline(dir, out)).toEqual({ edited: true, regions: { trimRegions: [], speedRegions } });
    // A video the latest render did not produce: unknown, no regions.
    expect(await exportTimeline(dir, join(dir, "older.mp4"))).toEqual({ edited: null });
    // An export without trims or speed-ups: not edited, no regions.
    await record({ timelineEdited: false, timeline: { trimRegions: [], speedRegions: [] } });
    expect(await exportTimeline(dir, out)).toEqual({ edited: false });
    // A record from before `timeline` was written: edited, but no regions to map through.
    await writeFile(join(dir, "render.json"), JSON.stringify({ outputPath: out, timelineEdited: true }));
    expect(await exportTimeline(dir, out)).toEqual({ edited: true });
    // A missing or unreadable record: unknown.
    await writeFile(join(dir, "render.json"), "{not json");
    expect(await exportTimeline(dir, out)).toEqual({ edited: null });
    await rm(join(dir, "render.json"));
    expect(await exportTimeline(dir, out)).toEqual({ edited: null });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
