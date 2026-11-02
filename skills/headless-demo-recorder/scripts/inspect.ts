// Evidence for reviewing an export: one frame per action, tiled into a contact sheet.
// The tool cannot judge whether a zoom "looks right"; it makes that cheap to check.

import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ffprobe, runOk } from "./exec.ts";
import { RENDER_RECORD, type RenderResult } from "./render.ts";
import type { ActionEvent } from "./types.ts";

/** `timelineEdited`: false for the raw capture, the render record's value for the latest export,
 * null when unknown (no render record for this video). */
export type InspectResult = { sheet: string; frames: { index: number; tMs: number; kind: string; caption?: string; label?: string }[]; timelineEdited: boolean | null; note: string };

async function timelineEdited(projDir: string, videoPath: string): Promise<boolean | null> {
  if (resolve(videoPath) === resolve(projDir, "capture.mp4")) return false;
  const rec = await readFile(join(projDir, RENDER_RECORD), "utf8").then((t) => JSON.parse(t) as RenderResult, () => undefined);
  return rec && resolve(rec.outputPath) === resolve(videoPath) ? rec.timelineEdited : null;
}

export async function inspect(projDir: string, videoPath: string): Promise<InspectResult> {
  const events = JSON.parse(await readFile(join(projDir, "events.json"), "utf8")) as ActionEvent[];
  const probe = await ffprobe(videoPath);
  // The export keeps the capture timeline unless trims/speed-ups changed it; map by ratio.
  const capture = JSON.parse(await readFile(join(projDir, "capture.json"), "utf8")) as { durationMs: number };
  const ratio = capture.durationMs > 0 ? probe.durationMs / capture.durationMs : 1;
  const picks = events.length ? events : [{ tMs: 0, kind: "mark" } as ActionEvent];
  const frames = picks.map((e, index) => ({ index, tMs: Math.round(Math.min(e.tMs * ratio + 350, probe.durationMs - 50)), kind: e.kind, caption: e.caption, label: e.label }));

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
  const edited = await timelineEdited(projDir, videoPath);
  return {
    sheet,
    frames,
    timelineEdited: edited,
    note: edited ? "export has trim/speed regions; frame times are approximate" : speedNote(ratio),
  };
}

const speedNote = (ratio: number) =>
  Math.abs(ratio - 1) > 0.05
    ? "export length differs from the capture (speed-ups/trims); frame times are approximate"
    : "tiles are in action order, left-to-right, ~350ms after each action";
