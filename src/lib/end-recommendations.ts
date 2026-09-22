// Decision logic for the post-playback "More Like This" overlay (issue #1304).
//
// The overlay may only appear after a NATURAL completion (mpv eof / HTML5
// `ended`) of a movie or of the actual final listed episode of a series, and
// only when it cannot interrupt anything: autoplay to a next episode, the
// Up Next queue, sleep-at-end, a Together room, casting, PiP or HDR stage.

export type EndRecommendationCompletion = "movie" | "series-finale";

export type EndRecommendationInput = {
  /** Player snapshot status; only "ended" counts as natural completion. */
  status: string;
  /** Snapshot error code; any error suppresses the overlay. */
  errorCode: string | null;
  durationSec: number;
  mediaType: string | null | undefined;
  hasEpisode: boolean;
  /** Current episode positively located in the resolved episode list. */
  seriesCurrentFound: boolean;
  hasNextEpisode: boolean;
  isLive: boolean;
  inRoom: boolean;
  queueLength: number;
  sleepAtEndArmed: boolean;
  pipMode: boolean;
  casting: boolean;
  /** Player overlay layers are hidden (HDR stage window active). */
  overlayHidden: boolean;
};

export type EndRecommendationSuppressionReason =
  | "playback-error"
  | "not-naturally-completed"
  | "no-duration"
  | "live"
  | "room-active"
  | "queue-pending"
  | "sleep-armed"
  | "pip"
  | "casting"
  | "overlay-hidden"
  | "next-episode"
  | "series-finale-unconfirmed"
  | "unsupported-media";

export type EndRecommendationDecision =
  | {
      show: true;
      completion: EndRecommendationCompletion;
      reason: "movie-completed" | "series-finale-completed";
    }
  | { show: false; reason: EndRecommendationSuppressionReason };

export function evaluateEndRecommendation(
  input: EndRecommendationInput,
): EndRecommendationDecision {
  // Manual stops never reach "ended": mpv ignores `end-file` for stop/quit/
  // redirect reasons and reports other non-eof ends as errors; the HTML5
  // bridge only sets "ended" from the element's `ended` event.
  if (input.errorCode != null || input.status === "error") {
    return { show: false, reason: "playback-error" };
  }
  if (input.status !== "ended") return { show: false, reason: "not-naturally-completed" };
  if (input.durationSec <= 0) return { show: false, reason: "no-duration" };
  if (input.isLive) return { show: false, reason: "live" };
  if (input.inRoom) return { show: false, reason: "room-active" };
  if (input.queueLength > 0) return { show: false, reason: "queue-pending" };
  if (input.sleepAtEndArmed) return { show: false, reason: "sleep-armed" };
  if (input.pipMode) return { show: false, reason: "pip" };
  if (input.casting) return { show: false, reason: "casting" };
  if (input.overlayHidden) return { show: false, reason: "overlay-hidden" };
  // A playable next episode means autoplay/Up Next owns the transition.
  if (input.hasNextEpisode) return { show: false, reason: "next-episode" };

  if (input.hasEpisode) {
    if (input.mediaType === "series" && input.seriesCurrentFound) {
      return { show: true, completion: "series-finale", reason: "series-finale-completed" };
    }
    // An episode is playing but the series finale cannot be proven (episode
    // list unresolved, current episode missing from it, or non-series type):
    // "no playable next episode" alone must not count as a finale.
    return { show: false, reason: "series-finale-unconfirmed" };
  }
  if (input.mediaType === "series") return { show: false, reason: "series-finale-unconfirmed" };
  if (input.mediaType === "movie" || input.mediaType === "anime") {
    return { show: true, completion: "movie", reason: "movie-completed" };
  }
  return { show: false, reason: "unsupported-media" };
}

export type EndRecommendationPhase = "idle" | "pending" | "ready" | "empty";

export function deriveEndRecommendationView(input: {
  /** Current eligibility from evaluateEndRecommendation(). */
  eligible: boolean;
  itemCount: number;
  /** Detail request settled (not loading). */
  settled: boolean;
}): { phase: EndRecommendationPhase; holdClose: boolean; visible: boolean } {
  // The current signal always wins so autoplay/queue/rooms keep priority over
  // the overlay and over holding the auto-close, even if the overlay already
  // showed for this source.
  if (!input.eligible) return { phase: "idle", holdClose: false, visible: false };
  if (input.itemCount > 0) return { phase: "ready", holdClose: true, visible: true };
  // Hold the normal end-of-playback close while the recommendation request is
  // still in flight; when it settles empty, release so the old behavior
  // (auto-close after the post-end delay) runs unchanged.
  if (input.settled) return { phase: "empty", holdClose: false, visible: false };
  return { phase: "pending", holdClose: true, visible: false };
}
