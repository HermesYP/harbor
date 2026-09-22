import type { MediaListStatus } from "./types.ts";

/**
 * AniList list-entry state, reduced to the fields a progress sync needs.
 *
 * `repeat` is AniList's "amount of times the user has rewatched/read the media"
 * and is nullable, so an entry that has never been rewatched reports null.
 * `progress` is the number of episodes consumed in the current cycle.
 * https://docs.anilist.co/reference/object/medialist
 */
export type EntryState = {
  status: MediaListStatus | null;
  progress: number;
  repeat: number | null;
};

export type ProgressDecision =
  | { action: "skip"; reason: "completed" | "episode-latest" }
  | { action: "update"; progress: number; status: MediaListStatus; repeat?: number };

function hasTotal(total: number): boolean {
  return Number.isFinite(total) && total > 0;
}

/**
 * Decide what a finished episode means for an AniList entry.
 *
 * An entry AniList reports as COMPLETED is left alone: the user has finished
 * the series and Harbor does not start a rewatch on their behalf. A rewatch is
 * tracked only while AniList says the entry is REPEATING, where progress walks
 * up to the episode total and reaching it moves the repeat counter one past the
 * value the live entry reports.
 */
export function decideAnimeProgress(
  entry: EntryState | null,
  episode: number,
  total: number,
): ProgressDecision {
  if (entry?.status === "COMPLETED") return { action: "skip", reason: "completed" };

  const progress = entry?.progress ?? 0;
  if (progress >= episode) return { action: "skip", reason: "episode-latest" };

  const repeating = entry?.status === "REPEATING";
  if (repeating && hasTotal(total) && episode >= total) {
    return {
      action: "update",
      progress: Math.min(episode, total),
      status: "COMPLETED",
      repeat: (entry.repeat ?? 0) + 1,
    };
  }

  return {
    action: "update",
    progress: hasTotal(total) ? Math.min(episode, total) : episode,
    status: repeating ? "REPEATING" : hasTotal(total) && episode >= total ? "COMPLETED" : "CURRENT",
  };
}
