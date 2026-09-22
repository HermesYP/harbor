import type { PlayerSnapshot } from "@/lib/player/bridge";
import type { PlayEpisode, PlayerSrc } from "@/lib/view";
import type { Meta } from "@/lib/cinemeta";
import { useTitleDetail } from "@/components/player/cast-modal/use-title-detail";
import { deriveEndRecommendationView, evaluateEndRecommendation } from "@/lib/end-recommendations";

const MAX_RECOMMENDATIONS = 14;

/**
 * Arms the post-playback "More Like This" overlay after a natural movie or
 * series-finale completion and loads recommendations through the same detail
 * request the cast modal/title panel already uses.
 *
 * All eligibility/suppression rules live in the pure
 * evaluateEndRecommendation() so they stay unit-testable; this hook only
 * wires them to the player, holds the end-of-playback auto-close while the
 * request is in flight, and releases it when the request settles empty.
 *
 * Stale responses cannot surface: useTitleDetail cancels on meta/active
 * change, and PlayerView remounts per meta id so a detail result never
 * outlives its title.
 */
export function useEndRecommendations(params: {
  src: PlayerSrc;
  snap: PlayerSnapshot;
  adjacent: { prev: PlayEpisode | null; next: PlayEpisode | null; currentFound: boolean };
  inRoom: boolean;
  isLive: boolean;
  queueLength: number;
  sleepAtEndArmed: boolean;
  pipMode: boolean;
  casting: boolean;
  overlayHidden: boolean;
  tmdbKey: string | null;
}) {
  const { src, snap, adjacent, tmdbKey } = params;

  const decision = evaluateEndRecommendation({
    status: snap.status,
    errorCode: snap.errorCode,
    durationSec: snap.durationSec,
    mediaType: src.meta.type,
    hasEpisode: src.episode != null,
    seriesCurrentFound: adjacent.currentFound,
    hasNextEpisode: adjacent.next != null,
    isLive: params.isLive,
    inRoom: params.inRoom,
    queueLength: params.queueLength,
    sleepAtEndArmed: params.sleepAtEndArmed,
    pipMode: params.pipMode,
    casting: params.casting,
    overlayHidden: params.overlayHidden,
  });

  const { detail, loading } = useTitleDetail(src.meta, tmdbKey, decision.show);

  const recommendations = detail?.recommendations ?? [];
  const similar = detail?.similar ?? [];
  const items: Meta[] = (recommendations.length > 0 ? recommendations : similar).slice(
    0,
    MAX_RECOMMENDATIONS,
  );

  const view = deriveEndRecommendationView({
    eligible: decision.show,
    itemCount: items.length,
    settled: !loading,
  });

  return { phase: view.phase, items, holdClose: view.holdClose, visible: view.visible };
}
