import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncCursorSidecar } from "./render.ts";
import type { CaptureResult } from "./types.ts";

const capture = (videoPath: string, realCursor = false): CaptureResult => ({
  videoPath, width: 1280, height: 720, durationMs: 3000, realCursor,
  events: [{ tMs: 1000, kind: "click", point: { cx: 0.5, cy: 0.5 } }],
});

test("cursor sidecar: written, removed on re-render without cursor, real telemetry kept", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hdr-cursor-"));
  const video = join(dir, "capture.mp4");
  const sidecar = `${video}.cursor.json`;
  const exists = () => readFile(sidecar).then(() => true, () => false);
  try {
    expect(await syncCursorSidecar(capture(video), {})).toBe(true);
    expect(await exists()).toBe(true);

    // Re-render with the cursor turned off: the stale synthetic track must not survive.
    expect(await syncCursorSidecar(capture(video), { syntheticCursor: false })).toBe(false);
    expect(await exists()).toBe(false);

    // A human-driven OpenScreen recording: the sidecar is real telemetry.
    await writeFile(sidecar, "real");
    expect(await syncCursorSidecar(capture(video, true), { syntheticCursor: false })).toBe(false);
    expect(await readFile(sidecar, "utf8")).toBe("real");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
