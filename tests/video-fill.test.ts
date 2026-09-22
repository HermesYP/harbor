// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import { HOTKEY_MAP } from "../src/lib/hotkeys.ts";
import {
  CROP_MODES,
  CROP_PRESETS,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
  clampZoom,
  cropModeIndex,
  stepZoom,
  zoomPercent,
} from "../src/lib/player/video-fill.ts";

test("manual zoom stays clamped to the mpv-safe 100%-200% range", () => {
  assert.equal(ZOOM_MIN, 0);
  assert.equal(ZOOM_MAX, 1);
  assert.equal(clampZoom(-0.4), 0);
  assert.equal(clampZoom(4), 1);
  assert.equal(clampZoom(Number.NaN), 0);

  let up = 0;
  for (let i = 0; i < 100; i++) up = stepZoom(up, ZOOM_STEP);
  assert.equal(up, 1, "stepping up saturates exactly at the clamp");

  let down = 1;
  for (let i = 0; i < 100; i++) down = stepZoom(down, -ZOOM_STEP);
  assert.equal(down, 0, "stepping down returns exactly to 100% and never below");
});

test("zoom steps accumulate without floating-point drift", () => {
  let z = 0;
  const seen: number[] = [];
  for (let i = 0; i < 4; i++) {
    z = stepZoom(z, ZOOM_STEP);
    seen.push(z);
  }
  assert.deepEqual(seen, [0.05, 0.1, 0.15, 0.2]);
  for (let i = 0; i < 20; i++) z = stepZoom(z, ZOOM_STEP);
  assert.equal(z, 1);
  assert.ok(Number.isFinite(z));
});

test("fine steps fully clear a 16:9 frame's pillarbox on a 3440x1440 window", () => {
  // A 16:9 video on this ultrawide window needs scale 2^required to remove the
  // side bars; uniform zoom then crops top/bottom. The step size must let the
  // user reach (and just pass) that boundary instead of overshooting wildly.
  const windowAspect = 3440 / 1440;
  const required = Math.log2(windowAspect / (16 / 9));
  assert.ok(required > 0 && required < ZOOM_MAX, "boundary is inside the clamp range");

  let z = 0;
  let presses = 0;
  while (z < required && presses < 40) {
    z = stepZoom(z, ZOOM_STEP);
    presses++;
  }
  assert.ok(z >= required, "zoom-in reaches complete bar clearance");
  assert.ok(presses <= 12, `reachable in a handful of presses (took ${presses})`);

  // Worst-case overshoot is bounded by one step: the extra top/bottom crop
  // beyond the exact bar-removal zoom stays under 2% of frame height.
  const exactCrop = (1 - 1 / Math.pow(2, required)) / 2;
  const actualCrop = (1 - 1 / Math.pow(2, z)) / 2;
  assert.ok(actualCrop - exactCrop < 0.02, `overshoot ${actualCrop - exactCrop}`);
});

test("zoom, stretch, and aspect presets stay distinct modes", () => {
  const ids = CROP_MODES.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, "mode ids are unique");

  const zoom = CROP_MODES[cropModeIndex("zoom")];
  assert.equal(zoom.id, "zoom", "manual zoom mode exists");
  assert.notEqual(zoom.stretch, true, "zoom must not flip keepaspect");
  assert.equal(zoom.aspect, "-1", "zoom leaves the aspect override alone");
  assert.equal(zoom.panscan, 0);

  const stretch = CROP_MODES[cropModeIndex("stretch")];
  assert.equal(stretch.id, "stretch");
  assert.equal(stretch.stretch, true);
  assert.equal(stretch.zoom, 0, "stretch does not use video-zoom");

  assert.ok(
    CROP_PRESETS.some((m) => m.id === "21:9"),
    "ultrawide aspect preset exists for the issue's second ask",
  );
  assert.equal(CROP_MODES[cropModeIndex("21:9")].aspect, "21:9");

  assert.ok(
    !CROP_PRESETS.some((m) => m.id === "zoom"),
    "manual zoom is hotkey-stepped, not a preset",
  );
  assert.ok(CROP_PRESETS.some((m) => m.id === "fit"));
});

test("no mode or default applies zoom, panscan, or an aspect override unsolicited", () => {
  for (const mode of CROP_MODES) assert.equal(mode.zoom, 0, `${mode.id} carries no zoom`);
  const fit = CROP_MODES[cropModeIndex("fit")];
  assert.equal(fit.id, "fit");
  assert.deepEqual(
    { panscan: fit.panscan, aspect: fit.aspect, stretch: fit.stretch },
    { panscan: 0, aspect: "-1", stretch: undefined },
  );
  assert.equal(cropModeIndex("does-not-exist"), 0, "unknown modes fall back to Fit");

  const defaultsSource = readFileSync(
    new URL("../src/lib/settings/defaults.ts", import.meta.url),
    "utf8",
  );
  assert.match(defaultsSource, /cropMode: "fit"/, "configured default picture shape stays Fit");
});

test("configured zoom and crop hotkey defaults are preserved", () => {
  assert.equal(HOTKEY_MAP.playerPanscanUp.defaultBinding, "=");
  assert.equal(HOTKEY_MAP.playerPanscanDown.defaultBinding, "-");
  assert.equal(HOTKEY_MAP.playerCrop.defaultBinding, "v");
});

test("the zoom pill reports the clamped mpv scale as a percentage", () => {
  assert.equal(zoomPercent(0), 100);
  assert.equal(zoomPercent(ZOOM_STEP), 104);
  assert.equal(zoomPercent(1), 200);
  assert.equal(zoomPercent(5), 200, "percentage follows the same clamp as the property write");
  assert.ok(zoomPercent(0.5) > zoomPercent(0.25));
});
