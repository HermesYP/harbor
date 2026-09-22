import { useEffect, useRef, type RefObject } from "react";
import type { PlayerSnapshot } from "@/lib/player/bridge";
import { getPlaybackPosition } from "@/lib/player/playback-clock";
import type { PlayEpisode, PlayerSrc } from "@/lib/view";
import { createEndExitScheduler } from "./end-exit-scheduler";

const LIVE_RELOAD_DELAY_MS = 1000;
const LIVE_RELOAD_WINDOW_MS = 15000;
const LIVE_RELOAD_MAX = 5;

export function useAutoEndExit(params: {
  src: PlayerSrc;
  snap: PlayerSnapshot;
  nextEp: PlayEpisode | null;
  canChangeEpisode: boolean;
  roomGuest: boolean;
  isLive: boolean;
  suspend: boolean;
  holdForEndRecommendations: boolean;
  startedNearEndRef: RefObject<boolean>;
  reloadLive: () => void;
  closePlayer: () => void | Promise<void>;
}) {
  const {
    src,
    snap,
    nextEp,
    canChangeEpisode,
    roomGuest,
    isLive,
    suspend,
    holdForEndRecommendations,
    startedNearEndRef,
    reloadLive,
    closePlayer,
  } = params;
  // Owns the close timer across effect runs: the effect cleanup cancels a
  // pending timer, but only a timer that actually fires marks the source as
  // closed, so a cancelled schedule re-arms when the effect re-runs.
  const schedulerRef = useRef(createEndExitScheduler());
  const reloadTimesRef = useRef<number[]>([]);

  useEffect(() => {
    schedulerRef.current.reset();
    reloadTimesRef.current = [];
  }, [src.url]);

  useEffect(() => {
    if (snap.durationSec <= 0) return;
    const pos = getPlaybackPosition();
    const naturalEnd = snap.status === "ended";
    const errorAtEnd = snap.errorCode != null && pos >= snap.durationSec - 2;
    const reachedEnd = snap.status !== "playing" && pos >= snap.durationSec - 1;
    if (!naturalEnd && !errorAtEnd && !reachedEnd) return;

    if (isLive) {
      if (!naturalEnd) return;
      const now = Date.now();
      const recent = reloadTimesRef.current.filter((t) => now - t < LIVE_RELOAD_WINDOW_MS);
      if (recent.length < LIVE_RELOAD_MAX) {
        recent.push(now);
        reloadTimesRef.current = recent;
        const t = window.setTimeout(reloadLive, LIVE_RELOAD_DELAY_MS);
        return () => window.clearTimeout(t);
      }
      reloadTimesRef.current = recent;
    }

    if (suspend) return;
    // Hold the post-end auto-close while the "More Like This" overlay is
    // loading or showing; released (effect re-runs) when it settles empty.
    if (holdForEndRecommendations) return;
    if (!isLive && startedNearEndRef.current) return;
    if ((canChangeEpisode || roomGuest) && nextEp) return;
    // A hold/suspend/next-episode gate above cancels the pending timer via
    // this cleanup; re-running the effect below must be able to re-arm it
    // (e.g. a natural EOF whose title-detail request settles empty after a
    // transient loading hold), while a close that already fired never
    // schedules again for this source.
    const armed = schedulerRef.current.schedule(src.url, () => {
      void closePlayer();
    });
    if (!armed) return;
    return () => schedulerRef.current.cancel();
  }, [
    snap.status,
    snap.errorCode,
    snap.durationSec,
    nextEp,
    canChangeEpisode,
    roomGuest,
    isLive,
    suspend,
    holdForEndRecommendations,
    reloadLive,
    src.url,
    closePlayer,
  ]);
}
