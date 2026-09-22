// Choosing the episode a detail page resumes.
//
// Stremio's library state, the local Continue Watching store and the local
// resume store all keep pointing at the episode you last played, even after
// that episode is finished. Continue Watching runs those same entries through
// useCwAdvance, which rolls a finished episode on to the next unwatched one, so
// the home row and the detail page used to disagree about what "resume" means.
// These helpers are the detail-page half of that rule.
//
// The ordering (series-episodes.nextUnwatchedAfter) and the progress rule
// (episode-progress.getEpisodeProgress) are injected rather than imported so
// this module stays framework- and provider-free and directly testable; the
// detail view passes the real implementations in.

export type ResumeCandidate = {
  season: number;
  episode: number;
  t: number;
};

export type ResumeEpisode = {
  season: number;
  episode: number;
  airDate?: string;
  runtime?: number;
};

/** Loosely shaped pair: episodeHint, local CW entries and resume entries. */
export type ResumeFields = {
  season?: number;
  episode?: number;
};

export type ResumeTarget = {
  season: number;
  episode: number;
  /** The entry from the episode list, when the list contained it. */
  next?: ResumeEpisode;
};

export type ResumePicker = (
  episodes: ResumeEpisode[],
  from: { season: number; episode: number },
  isWatched: (season: number, episode: number) => boolean,
) => ResumeEpisode | null;

/** episode-progress.getEpisodeProgress, injected to keep this module leaf-free. */
export type EpisodeProgressFn = (
  id: string,
  season: number,
  episode: number,
  runtimeMin: number | null,
  traktImdbId: string | null,
  traktWatched: Set<string>,
  stremioWatched?: Set<string>,
) => { ratio: number; watched: boolean; startedAt: number };

export function isAiredEpisode(airDate: string | undefined, now: number = Date.now()): boolean {
  // Providers omit air dates often enough that treating them as unaired would
  // strand most catalogs, so a missing or unparseable date stays resumable.
  if (!airDate) return true;
  const t = Date.parse(airDate);
  return !Number.isFinite(t) || t <= now;
}

export function isResumeEntry(
  value: ResumeFields | null | undefined,
): value is { season: number; episode: number } {
  if (value == null) return false;
  const { season, episode } = value;
  return (
    typeof season === "number" &&
    typeof episode === "number" &&
    Number.isFinite(season) &&
    Number.isFinite(episode) &&
    season >= 1 &&
    episode >= 1
  );
}

/** Keeps the newest entry per episode; `sources` may arrive in any order. */
export function mergeResumeCandidates(
  ...sources: Array<Iterable<ResumeCandidate>>
): ResumeCandidate[] {
  const best = new Map<string, ResumeCandidate>();
  for (const source of sources) {
    for (const c of source) {
      if (!isResumeEntry(c)) continue;
      const key = `${c.season}:${c.episode}`;
      const prev = best.get(key);
      if (!prev || c.t > prev.t) best.set(key, c);
    }
  }
  return [...best.values()].sort((a, b) => b.t - a.t);
}

/**
 * `candidates` must be ordered newest first (see mergeResumeCandidates).
 * Returns null when the newest entry is finished and no later episode can be
 * resumed, leaving the caller to keep whatever it showed before.
 */
export function pickResumeEpisode(
  candidates: ResumeCandidate[],
  episodes: ResumeEpisode[] | null | undefined,
  isWatched: (season: number, episode: number) => boolean,
  pickNext: ResumePicker,
  now: number = Date.now(),
): ResumeTarget | null {
  const current = candidates[0];
  if (!current || !isResumeEntry(current)) return null;
  if (!isWatched(current.season, current.episode)) {
    return { season: current.season, episode: current.episode };
  }
  const aired = (episodes ?? []).filter((e) => isResumeEntry(e) && isAiredEpisode(e.airDate, now));
  if (!aired.some((e) => e.season === current.season && e.episode === current.episode)) {
    // The list does not describe this episode (stale, or still loading): keep
    // the entry rather than guessing a position in an unrelated ordering.
    return null;
  }
  const next = pickNext(aired, current, isWatched);
  if (!next) {
    // A finale, or the successor has not aired. Keeping the current episode
    // beats advancing to an episode nobody can watch.
    return null;
  }
  return { season: next.season, episode: next.episode, next };
}

/**
 * The watched rule shared with the Continue Watching row and the episode list.
 * Runtime is only passed when an episode carries one, never guessed from show
 * metadata (which is a movie running time for films). Callers supply the
 * tracker sets; the detail hero currently passes local resume, manually marked
 * watched and Stremio's library flags, so this is not a full tracker roll-up.
 */
export function makeWatchedChecker(
  ids: readonly string[],
  runtimeFor: (season: number, episode: number) => number | null,
  stremioWatched: ReadonlySet<string>,
  progressFn: EpisodeProgressFn,
): (season: number, episode: number) => boolean {
  return (season, episode) => {
    for (const id of ids) {
      if (
        progressFn(
          id,
          season,
          episode,
          runtimeFor(season, episode),
          null,
          EMPTY_WATCHED,
          stremioWatched as Set<string>,
        ).watched
      ) {
        return true;
      }
    }
    return false;
  };
}

const EMPTY_WATCHED = new Set<string>();

/**
 * Resume target for a detail page: the newest library/resume candidate, rolled
 * forward to the next unwatched aired episode once that candidate is finished.
 * Null means "keep the caller's previous answer".
 */
export function resolveDetailResume(
  candidates: ResumeCandidate[],
  episodes: ResumeEpisode[] | null | undefined,
  ids: readonly string[],
  stremioWatched: ReadonlySet<string>,
  pickNext: ResumePicker,
  progressFn: EpisodeProgressFn,
  now: number = Date.now(),
): ResumeTarget | null {
  const all = episodes ?? [];
  const aired = all.filter((e) => isAiredEpisode(e.airDate, now));
  // Runtime lookup spans the whole list: the newest entry may itself be unaired
  // or absent from `aired`, but its finished state still needs a runtime.
  const runtimeFor = (season: number, episode: number): number | null =>
    all.find((e) => e.season === season && e.episode === episode)?.runtime ?? null;
  return pickResumeEpisode(
    mergeResumeCandidates(candidates),
    aired,
    makeWatchedChecker(ids, runtimeFor, stremioWatched, progressFn),
    pickNext,
    now,
  );
}
