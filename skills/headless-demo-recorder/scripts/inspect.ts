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

/** The render record of the export at `videoPath`; undefined for the raw capture or a video this
 * project's latest successful render did not produce. `timeline` is missing in records from older versions. */
async function exportRecord(projDir: string, videoPath: string): Promise<Partial<RenderRecord> & Pick<RenderRecord, "timelineEdited"> | undefined> {
  if (resolve(videoPath) === resolve(projDir, "capture.mp4")) return undefined;
  const rec = await readFile(join(projDir, RENDER_RECORD), "utf8").then((t) => JSON.parse(t) as RenderRecord, () => undefined);
  return rec && resolve(rec.outputPath) === resolve(videoPath) ? rec : undefined;
}

export async function inspect(projDir: string, videoPath: string): Promise<InspectResult> {
  const events = JSON.parse(await readFile(join(projDir, "events.json"), "utf8")) as ActionEvent[];
  const probe = await ffprobe(videoPath);
  const capture = JSON.parse(await readFile(join(projDir, "capture.json"), "utf8")) as { durationMs: number };
  const exp = await exportRecord(projDir, videoPath);
  // Map through the export's trim/speed regions when known; the remaining ratio absorbs small
  // length differences (frame rounding). Otherwise the whole timeline is scaled by one ratio.
  const regions: Regions | undefined = exp?.timelineEdited ? exp.timeline : undefined;
  const toExport = (t: number) => (regions ? exportTimeMs(t, regions) : t);
  const expected = toExport(capture.durationMs);
  const ratio = expected > 0 ? probe.durationMs / expected : 1;
  const picks = events.length ? events : [{ tMs: 0, kind: "mark" } as ActionEvent];
  // ~350ms after the action, on the capture timeline, so the UI's reaction is in frame.
  const frames = picks.map((e, index) => ({ index, tMs: Math.round(Math.min(toExport(e.tMs + 350) * ratio, probe.durationMs - 50)), kind: e.kind, caption: e.caption, label: e.label }));

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
  const edited = resolve(videoPath) === resolve(projDir, "capture.mp4") ? false : exp ? exp.timelineEdited : null;
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
