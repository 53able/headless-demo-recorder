import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ffprobe, toMp4 } from "../exec.ts";
import type { ActionEvent, CaptureResult, FileSource } from "../types.ts";

/** Import an existing capture (QuickTime, OBS, agent-browser WebM, ...). */
export async function captureFile(src: FileSource, workDir: string): Promise<CaptureResult> {
  const mp4 = join(workDir, "capture.mp4");
  await toMp4(src.path, mp4);
  const probe = await ffprobe(mp4);
  const events = src.events ? (JSON.parse(await readFile(src.events, "utf8")) as ActionEvent[]) : [];
  return { videoPath: mp4, width: probe.width, height: probe.height, durationMs: probe.durationMs, events, realCursor: false };
}
