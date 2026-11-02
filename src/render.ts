import { access, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { compileEditor, synthesizeCursor } from "./compile.ts";
import { ffprobe, log, parseNdjson, run } from "./exec.ts";
import { ToolError } from "./errors.ts";
import type { CaptureResult, EditPlan, Output } from "./types.ts";

// Defaults copied from a project written by `openscreen record --project` (v1.13).
const EDITOR_DEFAULTS = {
  cursorTheme: "default", wallpaper: "/wallpapers/wallpaper11.jpg", wallpaperMotion: "none", shadowIntensity: 0.6,
  backgroundBlur: 0, motionBlurAmount: 0.2, depthOfField: true, borderRadius: 24, padding: 40,
  cropRegion: { x: 0, y: 0, width: 1, height: 1 }, zoomRegions: [], cameraFullscreenRegions: [], autoZoomEnabled: false,
  autoFocusAll: false, trimRegions: [], speedRegions: [], annotationRegions: [], aspectRatio: "auto",
  webcamLayoutPreset: "picture-in-picture", webcamMaskShape: "square", webcamMirrored: false, webcamReactiveZoom: true,
  webcamSizePreset: 40, webcamPosition: null, exportQuality: "good", exportFormat: "mp4", gifFrameRate: 15, gifLoop: true,
  gifSizePreset: "medium",
};

async function openscreen(args: string[], label: string, timeoutMs = 15 * 60_000) {
  const r = await run("openscreen", [...args, "--json"], { timeoutMs });
  const evs = parseNdjson(r.stdout);
  const done = evs.find((e) => e.event === "done" && e.success === true);
  if (r.code !== 0 || !done) {
    const err = evs.filter((e) => e.event === "error" || e.event === "warning");
    throw new ToolError("render", `OPENSCREEN_${label.toUpperCase()}_FAILED`, `openscreen ${label} failed (exit ${r.code}): ${JSON.stringify(err).slice(0, 1500)}\n${r.stderr.split("\n").filter((l) => !l.includes("content-protection")).slice(-15).join("\n")}`, "after-fix", "inspect the .openscreen project; if the schema changed, check the OpenScreen version");
  }
  return done;
}

/** `timelineEdited`: trim or speed regions changed the timeline, so export times no longer map
 * 1:1 to capture times (not eligible for automatic acceptance). */
export type RenderResult = {
  projectPath: string; outputPath: string; durationMs: number; width: number; height: number; zooms: number; annotations: number;
  trimRegions: number; speedRegions: number; timelineEdited: boolean;
};

/** Written next to the capture so `inspect` can report whether the export's timeline was edited. */
export const RENDER_RECORD = "render.json";

/** Write (or remove) `<video>.cursor.json`, which OpenScreen (v1.13) auto-loads from next to the
 * video. A synthetic track left by an earlier render must go when this render wants no cursor;
 * a real-cursor recording's sidecar is the recorded telemetry and is never touched. */
export async function syncCursorSidecar(capture: CaptureResult, plan: EditPlan): Promise<boolean> {
  const sidecar = `${capture.videoPath}.cursor.json`;
  const want = plan.syntheticCursor ?? (!capture.realCursor && capture.events.some((e) => e.point));
  if (want) await writeFile(sidecar, JSON.stringify(synthesizeCursor(capture.events, capture.durationMs)));
  else if (!capture.realCursor) await rm(sidecar, { force: true });
  return want;
}

/** Compile edits into a .openscreen project next to the captured media and export it.
 * Re-runnable: it only reads capture.mp4/events and rewrites the project + output. */
export async function render(projDir: string, name: string, capture: CaptureResult, plan: EditPlan, output: Output, opts: { force?: boolean } = {}): Promise<RenderResult> {
  const outPath = resolve(output.path);
  if (!opts.force && (await access(outPath).then(() => true, () => false))) {
    throw new ToolError("render", "OUTPUT_EXISTS", `${outPath} already exists`, "after-fix", "pass --force to overwrite, or change output.path");
  }
  const video = capture.videoPath;

  const patch = compileEditor(capture, plan);
  const wantCursor = await syncCursorSidecar(capture, plan);

  const { style, ...regions } = patch;
  const isGif = outPath.endsWith(".gif");
  const project = {
    version: 2,
    media: { screenVideoPath: video, ...(wantCursor ? { cursorCaptureMode: "editable-overlay" } : {}) },
    editor: { ...EDITOR_DEFAULTS, ...regions, ...style, exportFormat: isGif ? "gif" : "mp4", exportQuality: output.quality ?? "good" },
  };
  const projectPath = join(projDir, `${name}.openscreen`);
  await writeFile(projectPath, JSON.stringify(project, null, 2));
  log(`project: ${projectPath} (${patch.zoomRegions.length} zooms, ${patch.annotationRegions.length} annotations, ${patch.speedRegions.length} speed-ups, cursor=${wantCursor})`);

  const info = await run("openscreen", ["info", projectPath, "--json"]);
  const infoJson = parseNdjson(info.stdout)[0] as { screenVideoExists?: boolean } | undefined;
  if (info.code !== 0 || !infoJson?.screenVideoExists) throw new ToolError("render", "PROJECT_INVALID", `openscreen info rejected the project: ${info.stdout}${info.stderr.slice(-500)}`, "after-fix", "check that capture.mp4 sits next to the .openscreen file");

  if (plan.speechCaptions) {
    const p = await ffprobe(video);
    if (!p.hasAudio) log("speechCaptions skipped: the capture has no audio track");
    else await openscreen(["captions", projectPath], "captions");
  }

  const exportArgs = ["export", projectPath, "-o", outPath];
  if (isGif) {
    if (output.gifFps) exportArgs.push("--gif-fps", String(output.gifFps));
    if (output.gifSize) exportArgs.push("--gif-size", output.gifSize);
  } else {
    if (output.quality) exportArgs.push("--quality", output.quality);
    if (output.audio) exportArgs.push("--audio", resolve(output.audio), "--audio-mode", output.audioMode ?? "mix");
  }
  log(`exporting → ${outPath}`);
  await openscreen(exportArgs, "export");

  const st = await stat(outPath);
  if (st.size === 0) throw new ToolError("render", "EMPTY_OUTPUT", `export produced an empty file: ${outPath}`, "after-fix");
  const probe = await ffprobe(outPath);
  const result: RenderResult = {
    projectPath, outputPath: outPath, durationMs: probe.durationMs, width: probe.width, height: probe.height, zooms: patch.zoomRegions.length, annotations: patch.annotationRegions.length,
    trimRegions: patch.trimRegions.length, speedRegions: patch.speedRegions.length, timelineEdited: patch.trimRegions.length + patch.speedRegions.length > 0,
  };
  await writeFile(join(projDir, RENDER_RECORD), JSON.stringify(result, null, 2));
  return result;
}
