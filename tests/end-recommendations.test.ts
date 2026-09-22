// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import {
  deriveEndRecommendationView,
  evaluateEndRecommendation,
  type EndRecommendationInput,
} from "../src/lib/end-recommendations.ts";
import { computeAdjacent } from "../src/lib/episode-adjacency.ts";

function movie(overrides: Partial<EndRecommendationInput> = {}): EndRecommendationInput {
  return {
    status: "ended",
    errorCode: null,
    durationSec: 5400,
    mediaType: "movie",
    hasEpisode: false,
    seriesCurrentFound: false,
    hasNextEpisode: false,
    isLive: false,
    inRoom: false,
    queueLength: 0,
    sleepAtEndArmed: false,
    pipMode: false,
    casting: false,
    overlayHidden: false,
    ...overrides,
  };
}

function seriesFinale(overrides: Partial<EndRecommendationInput> = {}): EndRecommendationInput {
  return movie({
    mediaType: "series",
    hasEpisode: true,
    seriesCurrentFound: true,
    durationSec: 3000,
    ...overrides,
  });
}

test("a naturally finished movie shows recommendations", () => {
  const decision = evaluateEndRecommendation(movie());
  assert.deepEqual(decision, {
    show: true,
    completion: "movie",
    reason: "movie-completed",
  });
});

test("a confirmed series finale shows recommendations", () => {
  const decision = evaluateEndRecommendation(seriesFinale());
  assert.deepEqual(decision, {
    show: true,
    completion: "series-finale",
    reason: "series-finale-completed",
  });
});

test("a next episode always wins: autoplay must not be interrupted", () => {
  const decision = evaluateEndRecommendation(seriesFinale({ hasNextEpisode: true }));
  assert.deepEqual(decision, { show: false, reason: "next-episode" });
});

test("an unconfirmed finale (no playable/known next) is not a finale", () => {
  // Episode list unresolved, current episode missing from it, or a failed
  // fetch: "no next episode" alone must never arm the overlay.
  for (const found of [false]) {
    const decision = evaluateEndRecommendation(seriesFinale({ seriesCurrentFound: found }));
    assert.deepEqual(decision, { show: false, reason: "series-finale-unconfirmed" });
  }
  // A series played without episode coordinates cannot be proven final either.
  const noEpisode = evaluateEndRecommendation(seriesFinale({ hasEpisode: false }));
  assert.deepEqual(noEpisode, { show: false, reason: "series-finale-unconfirmed" });
  // Anime episodes follow the same rule (their adjacency is not resolved).
  const animeEpisode = evaluateEndRecommendation(
    seriesFinale({ mediaType: "anime", seriesCurrentFound: false }),
  );
  assert.deepEqual(animeEpisode, { show: false, reason: "series-finale-unconfirmed" });
});

test("manual stop, pause and loading states never trigger", () => {
  for (const status of ["playing", "paused", "loading", "idle"]) {
    const decision = evaluateEndRecommendation(movie({ status }));
    assert.deepEqual(decision, { show: false, reason: "not-naturally-completed" });
  }
});

test("errors never trigger, even near the end of the runtime", () => {
  assert.deepEqual(evaluateEndRecommendation(movie({ status: "error" })), {
    show: false,
    reason: "playback-error",
  });
  assert.deepEqual(evaluateEndRecommendation(movie({ errorCode: "decode" })), {
    show: false,
    reason: "playback-error",
  });
  assert.deepEqual(evaluateEndRecommendation(seriesFinale({ errorCode: "network" })), {
    show: false,
    reason: "playback-error",
  });
});

test("queue, sleep-at-end and rooms keep priority over the overlay", () => {
  assert.deepEqual(evaluateEndRecommendation(movie({ queueLength: 2 })), {
    show: false,
    reason: "queue-pending",
  });
  assert.deepEqual(evaluateEndRecommendation(movie({ sleepAtEndArmed: true })), {
    show: false,
    reason: "sleep-armed",
  });
  assert.deepEqual(evaluateEndRecommendation(movie({ inRoom: true })), {
    show: false,
    reason: "room-active",
  });
  assert.deepEqual(evaluateEndRecommendation(seriesFinale({ inRoom: true })), {
    show: false,
    reason: "room-active",
  });
});

test("live, pip, cast and HDR-stage states suppress the overlay", () => {
  assert.deepEqual(evaluateEndRecommendation(movie({ isLive: true })), {
    show: false,
    reason: "live",
  });
  assert.deepEqual(evaluateEndRecommendation(movie({ pipMode: true })), {
    show: false,
    reason: "pip",
  });
  assert.deepEqual(evaluateEndRecommendation(movie({ casting: true })), {
    show: false,
    reason: "casting",
  });
  assert.deepEqual(evaluateEndRecommendation(movie({ overlayHidden: true })), {
    show: false,
    reason: "overlay-hidden",
  });
  assert.deepEqual(evaluateEndRecommendation(movie({ durationSec: 0 })), {
    show: false,
    reason: "no-duration",
  });
});

test("anime and unknown media types without episodes behave like movies", () => {
  assert.deepEqual(evaluateEndRecommendation(movie({ mediaType: "anime" })), {
    show: true,
    completion: "movie",
    reason: "movie-completed",
  });
  assert.deepEqual(evaluateEndRecommendation(movie({ mediaType: "channel" })), {
    show: false,
    reason: "unsupported-media",
  });
});

test("view stays idle until eligible and tracks fetch phase", () => {
  // Not eligible: never hold the auto-close, never show.
  assert.deepEqual(deriveEndRecommendationView({ eligible: false, itemCount: 0, settled: true }), {
    phase: "idle",
    holdClose: false,
    visible: false,
  });
  // Eligible while the detail request is in flight: hold the auto-close.
  assert.deepEqual(deriveEndRecommendationView({ eligible: true, itemCount: 0, settled: false }), {
    phase: "pending",
    holdClose: true,
    visible: false,
  });
  // Recommendations arrived: show the overlay and keep holding the close.
  assert.deepEqual(deriveEndRecommendationView({ eligible: true, itemCount: 5, settled: false }), {
    phase: "ready",
    holdClose: true,
    visible: true,
  });
  // Settled with no recommendations (e.g. no TMDB key): release the hold so
  // the original post-end auto-close behavior runs.
  assert.deepEqual(deriveEndRecommendationView({ eligible: true, itemCount: 0, settled: true }), {
    phase: "empty",
    holdClose: false,
    visible: false,
  });
});

test("a lapsed eligibility drops the overlay and the hold", () => {
  // e.g. a queue item appeared or playback restarted after the overlay
  // showed: the current suppression signal always wins.
  assert.deepEqual(deriveEndRecommendationView({ eligible: false, itemCount: 9, settled: true }), {
    phase: "idle",
    holdClose: false,
    visible: false,
  });
});

test("computeAdjacent only confirms the finale it located", () => {
  const eps = [
    { season: 1, episode: 1 },
    { season: 1, episode: 2 },
    { season: 1, episode: 3 },
  ];
  const middle = computeAdjacent(eps, { season: 1, episode: 2 });
  assert.equal(middle.currentFound, true);
  assert.deepEqual(middle.next, { season: 1, episode: 3 });

  const last = computeAdjacent(eps, { season: 1, episode: 3 });
  assert.deepEqual(last, { prev: { season: 1, episode: 2 }, next: null, currentFound: true });

  const first = computeAdjacent(eps, { season: 1, episode: 1 });
  assert.equal(first.prev, null);
  assert.equal(first.currentFound, true);

  // Current episode missing from the list: nothing may be inferred.
  const missing = computeAdjacent(eps, { season: 2, episode: 1 });
  assert.deepEqual(missing, { prev: null, next: null, currentFound: false });
});
