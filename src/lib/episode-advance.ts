import type { PlayEpisode } from "./view";
import type { LibraryItem } from "./stremio";

export const FINISHED_RATIO = 0.9;

export function isPlaybackFinished(duration: number, offset: number): boolean {
  return duration > 0 && offset / duration >= FINISHED_RATIO;
}

export function isFinishedSeries(i: LibraryItem): boolean {
  if (i.type !== "series" || !i.state) return false;
  if ((i.state.flaggedWatched ?? 0) <= 0) return false;
  const dur = i.state.duration ?? 0;
  const off = i.state.timeOffset ?? 0;
  return dur <= 0 || isPlaybackFinished(dur, off);
}

export function isNextAired(isAnime: boolean, airDate: string | undefined): boolean {
  const t = airDate ? Date.parse(airDate) : NaN;
  if (isAnime) return Number.isFinite(t) && t <= Date.now();
  return !airDate || !Number.isFinite(t) || t <= Date.now();
}

export function nextUnwatchedAfter(
  eps: PlayEpisode[],
  from: { season: number; episode: number },
  isWatched: (season: number, episode: number) => boolean,
): PlayEpisode | null {
  const sorted = eps
    .filter((e) => e.season >= 1)
    .slice()
    .sort((a, b) => a.season - b.season || a.episode - b.episode);
  let idx = sorted.findIndex((e) => e.season === from.season && e.episode === from.episode);
  if (idx < 0) idx = 0;
  for (let i = idx; i < sorted.length; i++) {
    if (!isWatched(sorted[i].season, sorted[i].episode)) return sorted[i];
  }
  return null;
}

export type SeriesResume = {
  episode: PlayEpisode;
  completed: boolean;
  upNext: boolean;
};

export function resolveSeriesResume(
  current: PlayEpisode,
  episodes: PlayEpisode[] | undefined,
  isWatched: (season: number, episode: number) => boolean,
): SeriesResume {
  const completed = isWatched(current.season, current.episode);
  if (!completed) return { episode: current, completed: false, upNext: false };
  // Incomplete metadata must not send a viewer backwards to the first episode.
  const hasCurrent = episodes?.some(
    (e) => e.season === current.season && e.episode === current.episode,
  );
  const next = hasCurrent ? nextUnwatchedAfter(episodes!, current, isWatched) : null;
  if (next && isNextAired(false, next.airDate)) {
    return { episode: next, completed: false, upNext: true };
  }
  // A finale, unaired successor or unavailable metadata can still be replayed,
  // but never resume the completed episode's credits.
  return { episode: current, completed: true, upNext: false };
}
