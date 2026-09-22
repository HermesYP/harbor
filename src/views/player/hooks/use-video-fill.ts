import { useEffect, useRef, useState, type RefObject } from "react";
import type { PlayerBridge } from "@/lib/player/bridge";
import {
  CROP_MODES,
  CROP_PRESETS,
  cropModeIndex,
  stepZoom,
  zoomPercent,
} from "@/lib/player/video-fill";
import { t } from "@/lib/i18n";
import { useSettings } from "@/lib/settings";

export { CROP_PRESETS };

export function useVideoFill(
  bridgeRef: RefObject<PlayerBridge | null>,
  srcKey: string,
  loaded: boolean,
) {
  const { settings, update } = useSettings();
  const [pill, setPill] = useState<string | null>(null);
  const index = useRef(cropModeIndex(settings.cropMode));
  const zoom = useRef(0);
  const timer = useRef<number | null>(null);
  const appliedSrc = useRef<string | null>(null);

  const flash = (text: string) => {
    setPill(text);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setPill(null), 1200);
  };

  const apply = (i: number, zoomLevel: number, showPill: boolean) => {
    const mode = CROP_MODES[i];
    const bridge = bridgeRef.current;
    if (bridge) {
      bridge.setPanscan(mode.panscan);
      bridge.setAspectOverride(mode.aspect);
      bridge.setVideoZoom(mode.id === "zoom" ? zoomLevel : 0);
      bridge.setStretch(mode.stretch === true);
    }
    if (!showPill) return;
    if (mode.id === "zoom" && zoomLevel > 0) {
      flash(t("Zoom {pct}%", { pct: zoomPercent(zoomLevel) }));
    } else {
      flash(t(mode.label));
    }
  };

  useEffect(() => {
    index.current = cropModeIndex(settings.cropMode);
    zoom.current = 0;
    appliedSrc.current = null;
    apply(index.current, 0, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcKey]);

  useEffect(() => {
    if (!loaded || appliedSrc.current === srcKey) return;
    appliedSrc.current = srcKey;
    apply(index.current, zoom.current, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, srcKey]);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  const cycle = () => {
    const next = (index.current + 1) % CROP_MODES.length;
    index.current = next;
    if (CROP_MODES[next].id !== "zoom") zoom.current = 0;
    apply(next, zoom.current, true);
    update({ cropMode: CROP_MODES[next].id });
  };

  const step = (delta: number) => {
    const zoomIdx = cropModeIndex("zoom");
    if (index.current !== zoomIdx) {
      index.current = zoomIdx;
      update({ cropMode: "zoom" });
    }
    zoom.current = stepZoom(zoom.current, delta);
    apply(zoomIdx, zoom.current, true);
  };

  const setMode = (id: string) => {
    const i = cropModeIndex(id);
    index.current = i;
    if (CROP_MODES[i].id !== "zoom") zoom.current = 0;
    apply(i, zoom.current, true);
    update({ cropMode: CROP_MODES[i].id });
  };

  return { cycle, step, setMode, mode: settings.cropMode, pill };
}
