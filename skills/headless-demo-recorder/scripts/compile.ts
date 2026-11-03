// Turns an action log into OpenScreen editor regions (zooms, captions) and marker spans and an optional synthetic cursor track.
// Pure functions: no I/O, unit-tested in compile.test.ts.

import { deflateSync } from "node:zlib";
import type { ActionEvent, CaptureResult, EditPlan, NPoint, NRect } from "./types.ts";

export type ZoomRegion = { id: string; startMs: number; endMs: number; depth: number; focus: NPoint; focusMode: "manual"; source: "manual" };
export type AnnotationRegion = Record<string, unknown> & { id: string; startMs: number; endMs: number };
export type SpanRegion = { id: string; startMs: number; endMs: number };
export type SpeedRegion = SpanRegion & { speed: number };

export type EditorPatch = {
  zoomRegions: ZoomRegion[];
  annotationRegions: AnnotationRegion[];
  /** Rings burned into the video by `render` (OpenScreen annotations do not follow zooms). */
  markers: Marker[];
  trimRegions: SpanRegion[];
  speedRegions: SpeedRegion[];
  autoZoomEnabled: false;
  style: Record<string, unknown>;
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The part of an element that is inside the frame. Undefined when nothing of it is visible. */
export function visibleRect(r: NRect): NRect | undefined {
  const x0 = clamp(r.x, 0, 1), x1 = clamp(r.x + r.w, 0, 1);
  const y0 = clamp(r.y, 0, 1), y1 = clamp(r.y + r.h, 0, 1);
  if (x1 <= x0 || y1 <= y0) return undefined;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The action point of an element: the center of its visible part. Undefined when nothing of it
 * is in the frame (e.g. a dialog outside a desktop window): no zoom or marker should point there.
 * The raw center of a partly visible element is off-frame, which events.json validation rejects. */
export function centerOf(r: NRect): NPoint | undefined {
  const v = visibleRect(r);
  return v && { cx: v.x + v.w / 2, cy: v.y + v.h / 2 };
}
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

export const MARKER_LEAD_MS = 150;
export const MARKER_HOLD_MS = 1200;
const MARKER_POINT_SIZE = 0.06;
const MARKER_MIN_SIZE = 0.04;
const MARKER_MAX_AREA = 0.25;
const MARKER_GAP_MS = 50;
const MARKER_MIN_MS = 300;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = CRC_TABLE[(c ^ x) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const len = Buffer.alloc(4), crc = Buffer.alloc(4);
  len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A transparent PNG holding only a rounded-rectangle outline in #FFC400.
 * Sized in real pixels so stretching it onto a box of the same pixel size keeps the stroke width. */
export function ringPngBytes(wPx: number, hPx: number, strokePx = 4): Buffer {
  const w = Math.max(1, Math.round(wPx)), h = Math.max(1, Math.round(hPx));
  const r = Math.min(w, h) * 0.2, hx = w / 2 - r, hy = h / 2 - r;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 4 + 1);
    for (let x = 0; x < w; x++) {
      // Signed distance to the rounded rectangle (negative inside); the stroke is centered strokePx/2 inside the edge.
      const qx = Math.abs(x + 0.5 - w / 2) - hx, qy = Math.abs(y + 0.5 - h / 2) - hy;
      const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
      const a = clamp(strokePx / 2 + 0.5 - Math.abs(d + strokePx / 2), 0, 1);
      raw.set([255, 196, 0, Math.round(a * 255)], row + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}

export type Marker = { startMs: number; endMs: number; box: NRect };

/** The box to highlight for an event: its visible rect (or a small square at its point), at least
 * MARKER_MIN_SIZE per side and kept inside the frame. Undefined when off-frame or too large. */
function markerBox(e: ActionEvent): NRect | undefined {
  const p = e.point!;
  const v = e.rect ? visibleRect(e.rect) : { x: p.cx - MARKER_POINT_SIZE / 2, y: p.cy - MARKER_POINT_SIZE / 2, w: MARKER_POINT_SIZE, h: MARKER_POINT_SIZE };
  if (!v || v.w * v.h > MARKER_MAX_AREA) return undefined;
  const w = Math.max(v.w, MARKER_MIN_SIZE), h = Math.max(v.h, MARKER_MIN_SIZE);
  return { x: clamp(v.x + v.w / 2 - w / 2, 0, 1 - w), y: clamp(v.y + v.h / 2 - h / 2, 0, 1 - h), w, h };
}

/** One marker per clicked/typed element, from just before the action until shortly after, so a
 * timing error of a few hundred ms still lands inside it. Ends before the next marker starts. */
export function compileMarkers(events: ActionEvent[], durationMs: number): Marker[] {
  const targets = normalizeEvents(events, durationMs)
    .filter((e) => e.point && !e.redact && (e.kind === "click" || e.kind === "type"))
    .flatMap((e) => { const box = markerBox(e); return box ? [{ t: e.tMs, box }] : []; });
  const out: Marker[] = [];
  targets.forEach((m, i) => {
    const startMs = clamp(m.t - MARKER_LEAD_MS, 0, durationMs);
    const next = targets[i + 1];
    const endMs = Math.min(m.t + MARKER_HOLD_MS, durationMs, next ? clamp(next.t - MARKER_LEAD_MS, 0, durationMs) - MARKER_GAP_MS : durationMs);
    if (endMs - startMs < MARKER_MIN_MS) return;
    out.push({ startMs, endMs, box: m.box });
  });
  return out;
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
    markers: plan.marker === false ? [] : compileMarkers(events, durationMs),
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
