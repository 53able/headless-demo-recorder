// Joins several captures into one video: scene planning, coordinate mapping and the
// ffmpeg composite argv. Pure functions (unit-tested in compose.test.ts) except buildComposite, which runs ffmpeg.
// Rects named `cell`/`content` are fractions of the output frame (0..1).

import { compileAnnotations, compileZooms, normalizeEvents, type AnnotationRegion, type EditorPatch, type ZoomRegion } from "./compile.ts";
import { ffprobe, runOk } from "./exec.ts";
import type { ActionEvent, CaptureResult, Composition, EditPlan, NPoint, NRect, Scene } from "./types.ts";

export type AlignedCapture = CaptureResult & { t0EpochMs?: number };
export type Size = [number, number];
export const DEFAULT_SIZE: Size = [1920, 1080];

/** start/end are on the aligned timeline; the recording time is `t + lead`. */
export type StreamPlan = { scenario: string; start: number; end: number; lead: number; cell: NRect; content: NRect; offsetMs: number; padMs: number };
export type ScenePlan = { layout: Scene["layout"]; offsetMs: number; lengthMs: number; streams: StreamPlan[] };

export function cellsFor(layout: Scene["layout"], _size: Size): NRect[] {
  return layout === "single" ? [{ x: 0, y: 0, w: 1, h: 1 }] : [{ x: 0, y: 0, w: 0.5, h: 1 }, { x: 0.5, y: 0, w: 0.5, h: 1 }];
}

/** Letterbox srcW x srcH into a cell (pixels). Integer, even w/h, so ffmpeg and the coordinate mapping agree. */
export function fitRect(srcW: number, srcH: number, cellPx: { w: number; h: number }): NRect {
  const k = Math.min(cellPx.w / srcW, cellPx.h / srcH);
  const w = 2 * Math.floor((srcW * k) / 2);
  const h = 2 * Math.floor((srcH * k) / 2);
  return { x: Math.floor((cellPx.w - w) / 2), y: Math.floor((cellPx.h - h) / 2), w, h };
}

/** How much later each recording started than the last one to start. Missing t0EpochMs → 0. */
export function alignLeadMs(captures: Record<string, AlignedCapture>): Record<string, number> {
  const t0s = Object.values(captures).map((c) => c.t0EpochMs).filter((t): t is number => t !== undefined);
  const latest = Math.max(...t0s);
  return Object.fromEntries(Object.entries(captures).map(([n, c]) => [n, c.t0EpochMs === undefined ? 0 : latest - c.t0EpochMs]));
}

const cellPx = (cell: NRect, [W, H]: Size) => ({ w: Math.round(cell.w * W), h: Math.round(cell.h * H) });

export function planScenes(comp: Composition, captures: Record<string, AlignedCapture>): ScenePlan[] {
  const size = comp.size ?? DEFAULT_SIZE;
  const [W, H] = size;
  const leads = alignLeadMs(captures);
  let offsetMs = 0;
  return comp.scenes.map((scene) => {
    const cells = cellsFor(scene.layout, size);
    const streams = scene.streams.map((st, j) => {
      const cap = captures[st.scenario]!;
      const lead = leads[st.scenario]!;
      const cell = cells[j]!;
      const fit = fitRect(cap.width, cap.height, cellPx(cell, size));
      const content = { x: cell.x + fit.x / W, y: cell.y + fit.y / H, w: fit.w / W, h: fit.h / H };
      const start = st.startMs ?? 0;
      // A startMs past the (aligned) recording end yields an empty segment, not a negative one.
      const end = Math.max(start, Math.min(st.endMs ?? Infinity, cap.durationMs - lead));
      return { scenario: st.scenario, start, end, lead, cell, content, offsetMs, padMs: 0 };
    });
    const lengthMs = Math.max(...streams.map((s) => s.end - s.start));
    for (const s of streams) s.padMs = lengthMs - (s.end - s.start);
    const plan = { layout: scene.layout, offsetMs, lengthMs, streams };
    offsetMs += lengthMs;
    return plan;
  });
}

export const mapPoint = (p: NPoint, r: NRect): NPoint => ({ cx: r.x + p.cx * r.w, cy: r.y + p.cy * r.h });
export const mapRect = (q: NRect, r: NRect): NRect => ({ x: r.x + q.x * r.w, y: r.y + q.y * r.h, w: q.w * r.w, h: q.h * r.h });

/** The output has one zoom at a time: first come wins (ties → left cell, i.e. smaller cx); later overlaps are dropped, not cut. */
export function resolveZoomConflicts(zooms: ZoomRegion[]): ZoomRegion[] {
  const out: ZoomRegion[] = [];
  for (const z of [...zooms].sort((a, b) => a.startMs - b.startMs || a.focus.cx - b.focus.cx)) {
    if (out.length && z.startMs < out.at(-1)!.endMs) continue;
    out.push(z);
  }
  return out.map((z, i) => ({ ...z, id: `agent-zoom-${i + 1}` }));
}

type Box = { position: { x: number; y: number }; size: { width: number; height: number } };
/** Percent position/size (0..100 of the source frame) → percent of the output frame inside `r`. */
const mapBox = (a: AnnotationRegion, r: NRect): Box => {
  const b = a as unknown as Box;
  return {
    position: { x: r.x * 100 + b.position.x * r.w, y: r.y * 100 + b.position.y * r.h },
    size: { width: b.size.width * r.w, height: b.size.height * r.h },
  };
};

export function composeEditor(
  comp: Composition,
  captures: Record<string, AlignedCapture>,
  scenarioEdits: Record<string, EditPlan | undefined>,
): { patch: EditorPatch; events: ActionEvent[]; scenes: ScenePlan[] } {
  const scenes = planScenes(comp, captures);
  const zooms: ZoomRegion[] = [];
  const annotations: AnnotationRegion[] = [];
  const events: ActionEvent[] = [];
  scenes.forEach((sc, i) => {
    events.push({ tMs: sc.offsetMs, kind: "mark", label: `scene ${i + 1}: ${sc.layout}` });
    sc.streams.forEach((st, j) => {
      const cap = captures[st.scenario]!;
      const from = st.start + st.lead;
      const segLen = st.end - st.start;
      const local = normalizeEvents(cap.events, cap.durationMs)
        .filter((e) => e.tMs >= from && e.tMs < st.end + st.lead)
        .map((e) => ({ ...e, tMs: e.tMs - from }));
      // titles/style come only from the composition; scenario.edit supplies per-stream defaults.
      const plan: EditPlan = { ...scenarioEdits[st.scenario], ...comp.edit, titles: [] };
      const fontSize = sc.layout === "side-by-side" ? Math.round((plan.captionFontSize ?? 64) * 0.6) : plan.captionFontSize; // ponytail: 0.6 by eye; tune with captionFontSize if captions overflow
      const redact = plan.redact?.map((r) => ({ ...r, startMs: r.startMs - from, endMs: r.endMs - from })).filter((r) => r.endMs > 0 && r.startMs < segLen);
      const shift = (r: { startMs: number; endMs: number }) => ({ startMs: r.startMs + sc.offsetMs, endMs: r.endMs + sc.offsetMs });

      for (const z of compileZooms(local, segLen, plan.zoom)) zooms.push({ ...z, ...shift(z), focus: mapPoint(z.focus, st.content) });
      for (const a of compileAnnotations(local, segLen, { ...plan, redact, captionFontSize: fontSize }))
        annotations.push({ ...a, ...shift(a), ...mapBox(a, a.type === "blur" ? st.content : st.cell), id: `s${i + 1}-${j + 1}-${a.id}` });
      for (const e of local)
        events.push({
          ...e,
          tMs: e.tMs + sc.offsetMs,
          ...(e.point && { point: mapPoint(e.point, st.content) }),
          ...(e.rect && { rect: mapRect(e.rect, st.content) }),
        });
    });
  });
  const totalMs = scenes.reduce((n, s) => n + s.lengthMs, 0);
  annotations.push(...compileAnnotations([], totalMs, { titles: comp.edit?.titles, titleFontSize: comp.edit?.titleFontSize }));
  return {
    patch: { zoomRegions: resolveZoomConflicts(zooms), annotationRegions: annotations, trimRegions: [], speedRegions: [], autoZoomEnabled: false, style: comp.edit?.style ?? {} },
    events: events.sort((a, b) => a.tMs - b.tMs),
    scenes,
  };
}

const sec = (ms: number) => (ms / 1000).toFixed(3);

/** ffmpeg argv that joins the scenes into one H.264 file. `inputs` has one entry per (scene, stream), in order. */
export function compositeArgs(plan: ScenePlan[], inputs: { path: string; w: number; h: number }[], size: Size, outPath: string): string[] {
  const filters: string[] = [];
  const sceneLabels: string[] = [];
  let k = 0;
  plan.forEach((sc, i) => {
    const labels = sc.streams.map((st) => {
      const inp = inputs[k]!;
      const c = cellPx(st.cell, size);
      const f = fitRect(inp.w, inp.h, c);
      filters.push(
        `[${k}:v]trim=start=${sec(st.start + st.lead)}:end=${sec(st.end + st.lead)},setpts=PTS-STARTPTS,fps=30,scale=${f.w}:${f.h},` +
          `pad=${c.w}:${c.h}:${f.x}:${f.y}:color=0x111111,setsar=1,tpad=stop_mode=clone:stop_duration=${sec(st.padMs)}[v${k}]`,
      );
      return `[v${k++}]`;
    });
    if (labels.length === 1) return sceneLabels.push(labels[0]!);
    filters.push(`${labels.join("")}hstack=inputs=${labels.length}[sc${i}]`);
    sceneLabels.push(`[sc${i}]`);
  });
  filters.push(`${sceneLabels.join("")}concat=n=${plan.length}:v=1:a=0[out]`);
  return [
    "-y", "-v", "error", ...inputs.flatMap((inp) => ["-i", inp.path]),
    "-filter_complex", filters.join(";"), "-map", "[out]",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-r", "30", "-an", "-movflags", "+faststart", outPath,
  ];
}

/** Run the composite: one `-i` per (scene, stream), in plan order (the same capture.mp4 may repeat). */
export async function buildComposite(plan: ScenePlan[], captures: Record<string, AlignedCapture>, size: Size, outPath: string): Promise<{ width: number; height: number; durationMs: number }> {
  const inputs = plan.flatMap((sc) => sc.streams.map((st) => {
    const c = captures[st.scenario]!;
    return { path: c.videoPath, w: c.width, h: c.height };
  }));
  await runOk("ffmpeg", compositeArgs(plan, inputs, size, outPath));
  const { width, height, durationMs } = await ffprobe(outPath);
  return { width, height, durationMs };
}
