// Turns an action log into OpenScreen editor regions and a synthetic cursor track.
// Pure functions: no I/O, unit-tested in compile.test.ts.

import type { ActionEvent, CaptureResult, EditPlan, NPoint } from "./types.ts";

export type ZoomRegion = { id: string; startMs: number; endMs: number; depth: number; focus: NPoint; focusMode: "manual"; source: "manual" };
export type AnnotationRegion = Record<string, unknown> & { id: string; startMs: number; endMs: number };
export type SpanRegion = { id: string; startMs: number; endMs: number };
export type SpeedRegion = SpanRegion & { speed: number };

export type EditorPatch = {
  zoomRegions: ZoomRegion[];
  annotationRegions: AnnotationRegion[];
  trimRegions: SpanRegion[];
  speedRegions: SpeedRegion[];
  autoZoomEnabled: false;
  style: Record<string, unknown>;
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const dist = (a: NPoint, b: NPoint) => Math.hypot(a.cx - b.cx, a.cy - b.cy);

/** Events from files or the `plan` command may be unsorted or run past the video end. */
export const normalizeEvents = (events: ActionEvent[], durationMs: number): ActionEvent[] =>
  events.map((e) => ({ ...e, tMs: clamp(e.tMs, 0, durationMs) })).sort((a, b) => a.tMs - b.tMs);

/** One zoom per cluster of nearby actions; overlapping clusters are cut so regions never overlap. */
export function compileZooms(events: ActionEvent[], durationMs: number, plan: EditPlan["zoom"] = {}): ZoomRegion[] {
  if (plan.enabled === false) return [];
  const depth = plan.depth ?? 3;
  const lead = plan.leadMs ?? 500;
  const hold = plan.holdMs ?? 1800;
  const mergeDistance = plan.mergeDistance ?? 0.25;
  const targets = normalizeEvents(events, durationMs).filter((e) => e.point && e.zoom !== false && (e.kind === "click" || e.kind === "type"));

  const out: ZoomRegion[] = [];
  for (const e of targets) {
    const p = e.point!;
    const start = clamp(e.tMs - lead, 0, durationMs);
    const end = clamp(e.tMs + hold, 0, durationMs);
    const prev = out.at(-1);
    if (prev && start <= prev.endMs + 400 && dist(prev.focus, p) <= mergeDistance) {
      // Same area, close in time: extend and re-center between the actions.
      prev.endMs = end;
      prev.focus = { cx: (prev.focus.cx + p.cx) / 2, cy: (prev.focus.cy + p.cy) / 2 };
      continue;
    }
    if (prev && start < prev.endMs) prev.endMs = start;
    if (prev && prev.endMs - prev.startMs < 300) out.pop();
    out.push({ id: `agent-zoom-${out.length + 1}`, startMs: start, endMs: end, depth, focus: { cx: clamp(p.cx, 0, 1), cy: clamp(p.cy, 0, 1) }, focusMode: "manual", source: "manual" });
  }
  return out.filter((z) => z.endMs - z.startMs >= 300).map((z, i) => ({ ...z, id: `agent-zoom-${i + 1}` }));
}

function textAnnotation(id: string, text: string, startMs: number, endMs: number, pos: { x: number; y: number; w: number; h: number }, fontSize: number) {
  return {
    id, startMs, endMs, type: "text", content: text, textContent: text,
    position: { x: pos.x, y: pos.y }, size: { width: pos.w, height: pos.h },
    style: { color: "#ffffff", backgroundColor: "rgba(0,0,0,0.62)", fontSize, fontFamily: "Inter", fontWeight: "bold", fontStyle: "normal", textDecoration: "none", textAlign: "center", textAnimation: "fade" },
    // "frame" pins the text to the output frame so zooms do not move or scale it.
    space: "frame",
    zIndex: 2,
  };
}

/** Step captions become lower-third text that lasts until the next caption. */
export function compileAnnotations(events: ActionEvent[], durationMs: number, plan: EditPlan): AnnotationRegion[] {
  const out: AnnotationRegion[] = [];
  if (plan.stepCaptions !== false) {
    const caps = normalizeEvents(events, durationMs).filter((e) => e.caption);
    const starts = caps.map((e) => clamp(e.tMs - 200, 0, durationMs));
    caps.forEach((e, i) => {
      const start = starts[i]!;
      const nextStart = starts[i + 1] ?? durationMs;
      // At least 600ms when there is room, but never into the next caption or past the end.
      const end = Math.min(Math.max(start + 600, Math.min(e.tMs + 4500, nextStart - 100)), nextStart, durationMs);
      if (end - start < 300) return;
      out.push(textAnnotation(`agent-caption-${i + 1}`, e.caption!, start, end, { x: 8, y: 80, w: 84, h: 12 }, plan.captionFontSize ?? 64));
    });
  }
  (plan.titles ?? []).forEach((t, i) => out.push(textAnnotation(`agent-title-${i + 1}`, t.text, t.startMs, t.endMs, { x: 10, y: 38, w: 80, h: 20 }, plan.titleFontSize ?? 110)));

  const redactions = [
    ...events.filter((e) => e.redact && e.rect).map((e) => ({ rect: e.rect!, startMs: e.tMs, endMs: durationMs })),
    ...(plan.redact ?? []),
  ];
  redactions.forEach((r, i) => {
    const pad = 0.01;
    out.push({
      id: `agent-blur-${i + 1}`, startMs: clamp(r.startMs, 0, durationMs), endMs: clamp(r.endMs, 0, durationMs), type: "blur", content: "",
      position: { x: clamp((r.rect.x - pad) * 100, 0, 100), y: clamp((r.rect.y - pad) * 100, 0, 100) },
      size: { width: (r.rect.w + 2 * pad) * 100, height: (r.rect.h + 2 * pad) * 100 },
      style: {}, zIndex: 3, blurData: { type: "blur", shape: "rectangle", color: "white", intensity: 18, blockSize: 12 },
    });
  });
  return out;
}

/** Speed up long stretches with no action (loading spinners, typing pauses). */
export function compileIdleSpeedups(events: ActionEvent[], durationMs: number, plan: EditPlan): SpeedRegion[] {
  const gap = plan.idleSpeedupMs ?? 0;
  if (!gap) return [];
  const speed = plan.idleSpeed ?? 4;
  const times = [0, ...normalizeEvents(events, durationMs).map((e) => e.tMs), durationMs];
  const out: SpeedRegion[] = [];
  for (let i = 1; i < times.length; i++) {
    const a = times[i - 1]! + 1200; // keep ~1.2s after each action at normal speed
    const b = Math.min(times[i]! - 600, durationMs); // and a short lead-in before the next
    if (b - a >= gap) out.push({ id: `agent-speed-${out.length + 1}`, startMs: Math.round(a), endMs: Math.round(b), speed });
  }
  return out;
}

export function compileEditor(capture: CaptureResult, plan: EditPlan = {}): EditorPatch {
  const { durationMs } = capture;
  const events = normalizeEvents(capture.events, durationMs);
  return {
    zoomRegions: compileZooms(events, durationMs, plan.zoom),
    annotationRegions: compileAnnotations(events, durationMs, plan),
    trimRegions: (plan.trim ?? []).map((t, i) => ({ id: `agent-trim-${i + 1}`, startMs: t.startMs, endMs: t.endMs })),
    speedRegions: compileIdleSpeedups(events, durationMs, plan),
    autoZoomEnabled: false,
    style: plan.style ?? {},
  };
}

// ---- synthetic cursor ----

export type CursorSample = { timeMs: number; cx: number; cy: number; visible: boolean; interactionType: "move" | "click" | "mouseup" };

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** Headless actions never move the real pointer, so OpenScreen would show no cursor.
 * Build one that glides to each target and clicks on time. */
export function synthesizeCursor(events: ActionEvent[], durationMs: number, opts: { hz?: number; travelMs?: number } = {}): { version: 2; provider: "native"; samples: CursorSample[]; assets: [] } {
  const hz = opts.hz ?? 60;
  const travel = opts.travelMs ?? 650;
  const step = 1000 / hz;
  const targets = normalizeEvents(events, durationMs).filter((e) => e.point).map((e) => ({ t: e.tMs, p: e.point!, click: e.kind === "click" || e.kind === "type" }));
  const samples: CursorSample[] = [];
  if (targets.length === 0) return { version: 2, provider: "native", samples, assets: [] };

  let pos: NPoint = { cx: 0.5, cy: 0.62 };
  let t = 0;
  for (const tg of targets) {
    const moveStart = Math.max(t, tg.t - travel);
    for (; t < moveStart; t += step) samples.push({ timeMs: Math.round(t), ...pos, visible: true, interactionType: "move" });
    const from = pos;
    const span = Math.max(tg.t - moveStart, 1);
    for (; t < tg.t; t += step) {
      const k = ease(clamp((t - moveStart) / span, 0, 1));
      samples.push({ timeMs: Math.round(t), cx: from.cx + (tg.p.cx - from.cx) * k, cy: from.cy + (tg.p.cy - from.cy) * k, visible: true, interactionType: "move" });
    }
    pos = tg.p;
    if (tg.click) {
      // Back-to-back clicks: never emit a sample earlier than the previous one.
      const at = Math.max(tg.t, samples.at(-1)?.timeMs ?? 0);
      samples.push({ timeMs: Math.round(at), ...pos, visible: true, interactionType: "click" });
      samples.push({ timeMs: Math.round(at + 90), ...pos, visible: true, interactionType: "mouseup" });
      t = at + 90 + step;
    }
  }
  for (; t <= durationMs; t += step) samples.push({ timeMs: Math.round(t), ...pos, visible: true, interactionType: "move" });
  return { version: 2, provider: "native", samples, assets: [] };
}
