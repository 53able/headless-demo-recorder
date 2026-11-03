import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { burnMarkers, syncCursorSidecar, videoWithMarkers } from "./render.ts";
import { runOk } from "./exec.ts";
import type { CaptureResult } from "./types.ts";

const capture = (videoPath: string, realCursor = false): CaptureResult => ({
  videoPath, width: 1280, height: 720, durationMs: 3000, realCursor,
  events: [{ tMs: 1000, kind: "click", point: { cx: 0.5, cy: 0.5 } }],
});

test("cursor sidecar: off by default, written on request, stale synthetic track removed, real telemetry kept", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hdr-cursor-"));
  const video = join(dir, "capture.mp4");
  const sidecar = `${video}.cursor.json`;
  const exists = () => readFile(sidecar).then(() => true, () => false);
  try {
    expect(await syncCursorSidecar(capture(video), {})).toBe(false);
    expect(await exists()).toBe(false);

    expect(await syncCursorSidecar(capture(video), { syntheticCursor: true })).toBe(true);
    expect(await exists()).toBe(true);

    // Re-render with the default: the stale synthetic track must not survive.
    expect(await syncCursorSidecar(capture(video), {})).toBe(false);
    expect(await exists()).toBe(false);

    // A human-driven OpenScreen recording: the sidecar is real telemetry.
    await writeFile(sidecar, "real");
    expect(await syncCursorSidecar(capture(video, true), {})).toBe(false);
    expect(await readFile(sidecar, "utf8")).toBe("real");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ffmpeg is a hard prerequisite of this tool (capture and render use it), so a missing binary fails here with a reason.
async function frameAt(video: string, sec: number, w: number, h: number): Promise<(x: number, y: number) => number[]> {
  const p = Bun.spawn(["ffmpeg", "-v", "error", "-ss", String(sec), "-i", video, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { stdout: "pipe" });
  const buf = new Uint8Array(await new Response(p.stdout).arrayBuffer());
  return (x, y) => [...buf.subarray((y * w + x) * 3, (y * w + x) * 3 + 3)];
}

test("burnMarkers: ring edge is yellow inside the span only; videoWithMarkers drops a stale marked copy", async () => {
  expect(Bun.which("ffmpeg"), "ffmpeg is required on PATH").not.toBeNull();
  const dir = await mkdtemp(join(tmpdir(), "hdr-burn-"));
  try {
    const src = join(dir, "src.mp4");
    await runOk("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=320x180:d=2:r=30", "-pix_fmt", "yuv420p", src]);
    const out = join(dir, "out.mp4");
    // Box x 0.25..0.75, y 0.25..0.75 -> pixels (80,45)..(240,135); the ring's left edge is at x=80..84, y mid=90.
    await burnMarkers(src, out, [{ startMs: 500, endMs: 1500, box: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } }], { width: 320, height: 180 });
    const [r, g, b] = (await frameAt(out, 1, 320, 180))(82, 90)!;
    expect(r!).toBeGreaterThan(200); expect(g!).toBeGreaterThan(150); expect(b!).toBeLessThan(80);
    for (const t of [0.2, 1.8]) {
      const [r2, g2, b2] = (await frameAt(out, t, 320, 180))(82, 90)!;
      expect(Math.max(r2!, g2!, b2!)).toBeLessThan(40);
    }

    const projDir = join(dir, "proj");
    await Bun.$`mkdir -p ${projDir}`;
    const cap: CaptureResult = { videoPath: src, width: 320, height: 180, durationMs: 2000, realCursor: false, events: [] };
    const marked = join(projDir, "capture.marked.mp4");
    const withM = await videoWithMarkers(projDir, cap, [{ startMs: 500, endMs: 1500, box: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } }]);
    expect(withM).toEqual({ videoPath: marked, burned: 1 });
    expect(await readFile(marked).then(() => true, () => false)).toBe(true);
    expect(await videoWithMarkers(projDir, cap, [])).toEqual({ videoPath: src, burned: 0 });
    expect(await readFile(marked).then(() => true, () => false)).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
