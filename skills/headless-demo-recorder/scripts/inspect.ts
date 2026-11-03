// Evidence for reviewing an export: one frame per action, tiled into a contact sheet.
// The tool cannot judge whether a zoom "looks right"; it makes that cheap to check.

import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ffprobe, runOk } from "./exec.ts";
import { RENDER_RECORD, type RenderRecord } from "./render.ts";
import type { ActionEvent } from "./types.ts";

/** `timelineEdited`: false for the raw capture, the render record's value for the latest export,
 * null when unknown (no render record for this video). */
export type InspectResult = { sheet: string; frames: { index: number; tMs: number; kind: string; caption?: string; label?: string }[]; timelineEdited: boolean | null; note: string };

type Span = { startMs: number; endMs: number };
type Regions = { trimRegions?: Span[]; speedRegions?: (Span & { speed: number })[] };

/** Where capture time `tMs` lands in an export: trimmed spans are removed (a time inside one maps to
 * where the cut is), speed spans play `speed`x faster, everything else plays 1:1. */
export function exportTimeMs(tMs: number, r: Regions): number {
  const rate = (t: number) => (r.trimRegions ?? []).some((s) => t >= s.startMs && t < s.endMs) ? 0
    : 1 / ((r.speedRegions ?? []).find((s) => t >= s.startMs && t < s.endMs)?.speed || 1);
  const cuts = [...new Set([0, tMs, ...[...(r.trimRegions ?? []), ...(r.speedRegions ?? [])].flatMap((s) => [s.startMs, s.endMs])])]
    .filter((t) => t >= 0 && t <= tMs).sort((a, b) => a - b);
  return cuts.slice(1).reduce((out, t, i) => out + (t - cuts[i]!) * rate(cuts[i]!), 0);
}

/** Frame time in the export for each action (ms). The frame is taken ~350ms after the action, on the
 * capture timeline, so the UI's reaction is in view. With the export's regions it maps through them;
 * the residual ratio then absorbs only small length differences (frame rounding). Without regions the
 * whole timeline is scaled by one ratio. `ratio` is returned for the note in `inspect`. */
export function frameTimes(actionsMs: number[], captureMs: number, exportMs: number, regions?: Regions): { tMs: number[]; ratio: number } {
  const toExport = (t: number) => (regions ? exportTimeMs(t, regions) : t);
  const expected = toExport(captureMs);
  const ratio = expected > 0 ? exportMs / expected : 1;
  return { tMs: actionsMs.map((t) => Math.round(Math.min(toExport(t + 350) * ratio, exportMs - 50))), ratio };
}

/** Whether the video at `videoPath` has an edited timeline, and the regions to map frames through.
 * `edited`: false for the raw capture; the render record's value when this project's latest successful
 * render produced the video; null when unknown (no record, an unreadable one, or another video).
 * `regions` is set only when the record says edited and carries `timeline` (older records do not). */
export async function exportTimeline(projDir: string, videoPath: string): Promise<{ edited: boolean | null; regions?: Regions }> {
  if (resolve(videoPath) === resolve(projDir, "capture.mp4")) return { edited: false };
  let rec: Partial<RenderRecord> | undefined;
  try {
    rec = JSON.parse(await readFile(join(projDir, RENDER_RECORD), "utf8")) as Partial<RenderRecord>;
  } catch {
    return { edited: null };
  }
  if (!rec?.outputPath || resolve(rec.outputPath) !== resolve(videoPath) || typeof rec.timelineEdited !== "boolean") return { edited: null };
  return rec.timelineEdited && rec.timeline ? { edited: true, regions: rec.timeline } : { edited: rec.timelineEdited };
}

export async function inspect(projDir: string, videoPath: string): Promise<InspectResult> {
  const events = JSON.parse(await readFile(join(projDir, "events.json"), "utf8")) as ActionEvent[];
  const probe = await ffprobe(videoPath);
  const capture = JSON.parse(await readFile(join(projDir, "capture.json"), "utf8")) as { durationMs: number };
  const { edited, regions } = await exportTimeline(projDir, videoPath);
  const picks = events.length ? events : [{ tMs: 0, kind: "mark" } as ActionEvent];
  const { tMs: times, ratio } = frameTimes(picks.map((e) => e.tMs), capture.durationMs, probe.durationMs, regions);
  const frames = picks.map((e, index) => ({ index, tMs: times[index]!, kind: e.kind, caption: e.caption, label: e.label }));

  const tmp: string[] = [];
  for (const f of frames) {
    const out = join(projDir, `.inspect-${f.index}.png`);
    tmp.push(out);
    await runOk("ffmpeg", ["-v", "error", "-y", "-ss", String(f.tMs / 1000), "-i", videoPath, "-frames:v", "1", "-vf", "scale=480:-2", out]);
  }
  const cols = Math.min(4, frames.length);
  const rows = Math.ceil(frames.length / cols);
  const sheet = join(projDir, "inspect-sheet.png");
  await runOk("ffmpeg", ["-v", "error", "-y", "-i", join(projDir, ".inspect-%d.png"), "-vf", `tile=${cols}x${rows}:padding=6:color=white`, "-frames:v", "1", sheet]);
  await Promise.all(tmp.map((p) => rm(p, { force: true })));
  return {
    sheet,
    frames,
    timelineEdited: edited,
    note: regions ? "export has trim/speed regions; frame times are mapped through them (an action inside a trim shows the frame at the cut)"
      : edited ? "export has trim/speed regions but its render record predates them; frame times are approximate (render again to map them)" : speedNote(ratio),
  };
}

const speedNote = (ratio: number) =>
  Math.abs(ratio - 1) > 0.05
    ? "export length differs from the capture (speed-ups/trims); frame times are approximate"
    : "tiles are in action order, left-to-right, ~350ms after each action";
