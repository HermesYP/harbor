// Framework-independent picture-shape policy for the player (issue #1393).
// mpv remains the source of truth: these helpers only describe which property
// values Harbor pushes (panscan, video-zoom, video-aspect-override, keepaspect)
// when the user changes crop/aspect mode or steps manual zoom.

export type CropMode = {
  id: string;
  label: string;
  panscan: number;
  aspect: string;
  zoom: number;
  stretch?: boolean;
};

// mpv `video-zoom` is base-2 log2 scale: 0 = 100% (source size), 1 = 200%.
// Zoom-out never shrinks below the source size, so the frame always covers
// the window without introducing new bars.
export const ZOOM_MIN = 0;
export const ZOOM_MAX = 1;

// log2 step per zoom press. 0.05 is ~+3.6% scale per press: fine enough to
// land just past a baked-in black-bar boundary (issue #1393 asked for finer
// adjustment than the previous 0.1 step, which overshot by up to ~7% scale
// per press) while still reaching full ultrawide pillarbox clearance in a
// handful of presses.
export const ZOOM_STEP = 0.05;

// Zoom and Stretch are deliberately distinct: Zoom scales the source uniformly
// via mpv `video-zoom` (crops every edge, aspect preserved), while Stretch only
// flips `keepaspect` off (fills the window, geometry distorted, nothing cropped).
export const CROP_MODES: CropMode[] = [
  { id: "fit", label: "Fit", panscan: 0, aspect: "-1", zoom: 0 },
  { id: "fill", label: "Fill", panscan: 1, aspect: "-1", zoom: 0 },
  { id: "stretch", label: "Stretch", panscan: 0, aspect: "-1", zoom: 0, stretch: true },
  { id: "zoom", label: "Zoom", panscan: 0, aspect: "-1", zoom: 0 },
  { id: "16:9", label: "16:9", panscan: 0, aspect: "16:9", zoom: 0 },
  { id: "4:3", label: "4:3", panscan: 0, aspect: "4:3", zoom: 0 },
  { id: "21:9", label: "21:9", panscan: 0, aspect: "21:9", zoom: 0 },
  { id: "1.85:1", label: "1.85:1", panscan: 0, aspect: "1.85:1", zoom: 0 },
  { id: "original", label: "2.39:1", panscan: 0, aspect: "2.39:1", zoom: 0 },
];

// Selectable presets for menus/settings. Manual Zoom is stepped with the
// configured zoom hotkeys instead of picked from a list, so it is excluded.
export const CROP_PRESETS: ReadonlyArray<{ id: string; label: string }> = CROP_MODES.filter(
  (m) => m.id !== "zoom",
).map((m) => ({ id: m.id, label: m.label }));

export function cropModeIndex(id: string): number {
  const i = CROP_MODES.findIndex((m) => m.id === id);
  return i < 0 ? 0 : i;
}

export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return ZOOM_MIN;
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, value));
}

// Clamp first, then round to hundredths so repeated steps never accumulate
// floating-point drift (0.05 * 20 must land exactly on ZOOM_MAX).
export function stepZoom(current: number, delta: number): number {
  return Math.round(clampZoom(current + delta) * 100) / 100;
}

// Percentage shown in the on-screen pill: 2^log2 * 100, clamped like mpv use.
export function zoomPercent(log2: number): number {
  return Math.round(Math.pow(2, clampZoom(log2)) * 100);
}
