import type { PlayEpisode } from "./view";

export type EpisodeAdjacency = {
  prev: PlayEpisode | null;
  next: PlayEpisode | null;
  /**
   * True only when the current episode was positively located inside the
   * resolved episode list. Without this, `next === null` cannot distinguish a
   * real series finale from missing/failed episode metadata.
   */
  currentFound: boolean;
};

export function computeAdjacent(
  eps: PlayEpisode[],
  current: { season: number; episode: number },
): EpisodeAdjacency {
  const idx = eps.findIndex((v) => v.season === current.season && v.episode === current.episode);
  if (idx === -1) return { prev: null, next: null, currentFound: false };
  return {
    prev: idx > 0 ? eps[idx - 1] : null,
    next: idx < eps.length - 1 ? eps[idx + 1] : null,
    currentFound: true,
  };
}
