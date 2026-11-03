import { expect, test } from "bun:test";
import { exportTimeMs } from "./inspect.ts";

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
