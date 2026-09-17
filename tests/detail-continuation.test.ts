// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";

// Regression coverage for issue #1425: the home Continue Watching row advanced
// to the next episode after a finished episode, but the show detail page kept
// resuming the finished episode. The detail page now runs its resume
// candidates through the same next-unwatched rule useCwAdvance uses.
//
// What is real here: src/lib/detail-resume.ts, its selection logic, the
// episode ordering rule (a faithful copy of series-episodes.nextUnwatchedAfter,
// which cannot be imported under Node because it pulls in Vite-only asset
// imports) and the localStorage stores. What is a test double: `progressFn`
// below, which mirrors the local-storage/resume-store side of
// episode-progress.getEpisodeProgress (manual marks, resume ratio, the Stremio
// watched set) because that module has the same Vite-only import problem. The
// detail page passes the real getEpisodeProgress; a source-level test below
// pins that wiring.

const backing = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => backing.get(k) ?? null,
  setItem: (k: string, v: string) => {
    backing.set(k, String(v));
  },
  removeItem: (k: string) => {
    backing.delete(k);
  },
  clear: () => backing.clear(),
  key: (i: number) => [...backing.keys()][i] ?? null,
  get length() {
    return backing.size;
  },
};

const {
  isAiredEpisode,
  isResumeEntry,
  makeWatchedChecker,
  mergeResumeCandidates,
  resolveDetailResume,
} = await import("../src/lib/detail-resume.ts");
type ResumeEpisode = {
  season: number;
  episode: number;
  airDate?: string;
  runtime?: number;
};
type ProgressResult = { ratio: number; watched: boolean; startedAt: number };

const NOW = Date.parse("2024-06-01T00:00:00Z");
const PAST = "2024-01-01T00:00:00Z";
const FUTURE = "2024-12-01T00:00:00Z";
const SERIES = "tt1234567";
const EPISODE_MINUTES = 22;
const WATCHED_THRESHOLD = 0.85;

// Same episode ordering rule series-episodes.nextUnwatchedAfter applies.
function nextUnwatchedAfter(
  episodes: ResumeEpisode[],
  from: { season: number; episode: number },
  isWatched: (season: number, episode: number) => boolean,
): ResumeEpisode | null {
  const sorted = episodes.slice().sort((a, b) => a.season - b.season || a.episode - b.episode);
  let idx = sorted.findIndex((e) => e.season === from.season && e.episode === from.episode);
  if (idx < 0) idx = 0;
  for (let i = idx; i < sorted.length; i++) {
    if (!isWatched(sorted[i].season, sorted[i].episode)) return sorted[i];
  }
  return null;
}

// Test double for episode-progress.getEpisodeProgress. Mirrors its precedence:
// a manual "unwatched" mark returns {watched:false} BEFORE any other signal is
// consulted (episode-progress.ts:80), manual "watched" forces watched, then the
// resume ratio and the Stremio watched flag decide.
function progressFn(
  id: string,
  season: number,
  episode: number,
  runtimeMin: number | null,
  _traktImdbId: string | null,
  _traktWatched: Set<string>,
  stremioWatched?: Set<string>,
): ProgressResult {
  const manual = manualState(id, season, episode);
  if (manual === false) return { ratio: 0, watched: false, startedAt: 0 };
  const entry = resumeEntry(id, season, episode);
  const ms = entry?.ms ?? 0;
  const durationMs = runtimeMin && runtimeMin > 0 ? runtimeMin * 60_000 : 0;
  const ratio = durationMs > 0 && ms > 0 ? Math.min(1, ms / durationMs) : 0;
  const done = manual === true || stremioWatched?.has(`${season}:${episode}`) === true;
  return { ratio: done ? 1 : ratio, watched: done || ratio >= WATCHED_THRESHOLD, startedAt: 0 };
}

function resumeEntry(id: string, season: number, episode: number): { ms: number } | null {
  const all = JSON.parse(backing.get("harbor.resume") ?? "{}") as Record<string, { ms: number }>;
  return all[`${id}|s${season}e${episode}`] ?? null;
}

function manualState(id: string, season: number, episode: number): boolean | undefined {
  const key = `${id}|${season}|${episode}`;
  const on = new Set(JSON.parse(backing.get("harbor.manualwatched.v1") ?? "[]") as string[]);
  if (on.has(key)) return true;
  const off = new Set(JSON.parse(backing.get("harbor.manualunwatched.v1") ?? "[]") as string[]);
  if (off.has(key)) return false;
  return undefined;
}

function season(n: number, count: number, airDate: string = PAST): ResumeEpisode[] {
  return Array.from({ length: count }, (_, i) => ({
    season: n,
    episode: i + 1,
    airDate,
    runtime: EPISODE_MINUTES,
  }));
}

function resumeStore(entries: Array<[string, number]>): void {
  const all: Record<string, { ms: number; t: number }> = {};
  for (const [key, ms] of entries) {
    const m = /\|s(\d+)e(\d+)$/.exec(key);
    all[key] = { ms, t: m ? Number(m[2]) * 1000 : 0 };
  }
  backing.set("harbor.resume", JSON.stringify(all));
}

function resume(
  candidates: Array<{ season: number; episode: number; t: number }>,
  episodes: ResumeEpisode[],
  watched = new Set<string>(),
  ids: string[] = [SERIES],
) {
  return resolveDetailResume(
    candidates,
    episodes,
    ids,
    watched,
    nextUnwatchedAfter,
    progressFn,
    NOW,
  );
}

test("an in-progress episode still resumes where it left off", () => {
  resumeStore([[`${SERIES}|s22e7`, 5 * 60_000]]);
  const target = resume([{ season: 22, episode: 7, t: 1000 }], season(22, 10));
  assert.deepEqual(
    { season: target?.season, episode: target?.episode },
    { season: 22, episode: 7 },
  );
});

test("issue #1425: a finished episode resumes the next aired episode", () => {
  // Watched through the end credits, then backed out. The local resume entry
  // sits at the end of S22E7, so the detail page used to keep offering
  // "Resume S22:E7" while Continue Watching moved on to S22E8.
  resumeStore([[`${SERIES}|s22e7`, 20 * 60_000]]);
  const target = resume([{ season: 22, episode: 7, t: 2000 }], season(22, 10));
  assert.deepEqual(
    { season: target?.season, episode: target?.episode },
    { season: 22, episode: 8 },
  );
  assert.equal(target?.next?.episode, 8);
});

test("Stremio's watched flag also finishes an episode whose local entry is short", () => {
  // Backing out during the credits can leave the local resume entry below the
  // ratio threshold; the library's decoded watched set still says finished.
  resumeStore([[`${SERIES}|s22e7`, 16 * 60_000]]);
  const target = resume([{ season: 22, episode: 7, t: 3000 }], season(22, 10), new Set(["22:7"]));
  assert.equal(target?.episode, 8);
});

test("a finished episode whose next episode has not aired does not advance", () => {
  resumeStore([[`${SERIES}|s22e9`, 30 * 60_000]]);
  const episodes = [...season(22, 9), { season: 22, episode: 10, airDate: FUTURE, runtime: 22 }];
  assert.equal(resume([{ season: 22, episode: 9, t: 4000 }], episodes), null);
});

test("the finale does not advance past the end of the list", () => {
  resumeStore([[`${SERIES}|s22e10`, 30 * 60_000]]);
  assert.equal(resume([{ season: 22, episode: 10, t: 5000 }], season(22, 10)), null);
});

test("advancing can cross a season boundary", () => {
  resumeStore([[`${SERIES}|s1e3`, 30 * 60_000]]);
  const target = resume([{ season: 1, episode: 3, t: 6000 }], [...season(1, 3), ...season(2, 3)]);
  assert.deepEqual({ season: target?.season, episode: target?.episode }, { season: 2, episode: 1 });
});

test("a manually watched episode counts as finished without a resume entry", () => {
  backing.set("harbor.manualwatched.v1", JSON.stringify([`${SERIES}|21|5`]));
  const target = resume([{ season: 21, episode: 5, t: 7000 }], season(21, 10));
  assert.equal(target?.episode, 6);
});

test("a manually unwatched episode still resumes", () => {
  resumeStore([[`${SERIES}|s20e4`, 30 * 60_000]]);
  backing.set("harbor.manualunwatched.v1", JSON.stringify([`${SERIES}|20|4`]));
  const target = resume([{ season: 20, episode: 4, t: 8000 }], season(20, 10));
  assert.equal(target?.episode, 4);
});

test("a manual unwatched mark overrides Stremio's watched flag", () => {
  // episode-progress.ts returns {watched:false} for manual === false before it
  // ever looks at the Stremio bit, so the episode stays resumable.
  resumeStore([[`${SERIES}|s19e2`, 30 * 60_000]]);
  backing.set("harbor.manualunwatched.v1", JSON.stringify([`${SERIES}|19|2`]));
  const target = resume([{ season: 19, episode: 2, t: 8500 }], season(19, 10), new Set(["19:2"]));
  assert.equal(target?.episode, 2);
});

test("issue #1425 with production-shaped Cinemeta episodes (no runtime)", () => {
  // cinemetaFull.videos carry no runtime, so the ratio can never run for a
  // normal series: the finished signal is autosave's manual watched mark
  // (use-resume-autosave sets it at >=85% or on "ended") plus Stremio's bit.
  // This is the actual reporter path, not a runtime-list hypothetical.
  const cinemetaEpisodes: ResumeEpisode[] = Array.from({ length: 10 }, (_, i) => ({
    season: 22,
    episode: i + 1,
    airDate: PAST,
  }));
  resumeStore([
    [`${SERIES}|s22e7`, 20 * 60_000],
    [`${SERIES}|s22e8`, 21 * 60_000],
  ]);
  backing.set("harbor.manualwatched.v1", JSON.stringify([`${SERIES}|22|7`]));

  const finished = resume([{ season: 22, episode: 7, t: 20_000 }], cinemetaEpisodes);
  assert.deepEqual(
    { season: finished?.season, episode: finished?.episode },
    { season: 22, episode: 8 },
  );

  // After the follow-up episode is finished too, the next one is offered.
  backing.set("harbor.manualwatched.v1", JSON.stringify([`${SERIES}|22|7`, `${SERIES}|22|8`]));
  const nextAgain = resume([{ season: 22, episode: 8, t: 21_000 }], cinemetaEpisodes);
  assert.equal(nextAgain?.episode, 9);

  // The whole season finished: nothing left to advance to, so the caller keeps
  // its previous answer instead of jumping to the pilot.
  const allWatched: ResumeEpisode[] = [
    { season: 22, episode: 7, airDate: PAST },
    { season: 22, episode: 8, airDate: PAST },
  ];
  backing.set("harbor.manualwatched.v1", JSON.stringify([`${SERIES}|22|7`, `${SERIES}|22|8`]));
  assert.equal(resume([{ season: 22, episode: 8, t: 22_000 }], allWatched), null);
});

test("skipped episodes are skipped over, not resumed", () => {
  backing.clear();
  resumeStore([
    [`${SERIES}|s22e7`, 30 * 60_000],
    [`${SERIES}|s22e8`, 30 * 60_000],
    [`${SERIES}|s22e9`, 30 * 60_000],
  ]);
  const target = resume([{ season: 22, episode: 7, t: 9000 }], season(22, 10));
  assert.equal(target?.episode, 10);
});

test("a stale entry missing from the episode list is left alone", () => {
  backing.clear();
  resumeStore([[`${SERIES}|s22e7`, 30 * 60_000]]);
  // No runtime is known for the stale episode, so it cannot be proven finished
  // and the caller's previous answer stands.
  const unknownRuntime = resume([{ season: 22, episode: 7, t: 10_000 }], season(3, 5));
  assert.deepEqual(
    { season: unknownRuntime?.season, episode: unknownRuntime?.episode },
    { season: 22, episode: 7 },
  );
  // With the runtime known, the finished entry has no later aired episode here,
  // so the caller keeps its previous answer rather than inventing one.
  const knownRuntime = [...season(3, 5), { season: 22, episode: 7, airDate: PAST, runtime: 22 }];
  assert.equal(resume([{ season: 22, episode: 7, t: 11_000 }], knownRuntime), null);
});

test("an empty or invalid candidate list yields no target", () => {
  assert.equal(resume([], season(22, 10)), null);
  assert.equal(resume([{ season: 0, episode: 0, t: 1 }], season(22, 10)), null);
});

test("the newest entry wins when several sources disagree", () => {
  const merged = mergeResumeCandidates(
    [{ season: 22, episode: 6, t: 100 }],
    [
      { season: 22, episode: 7, t: 900 },
      { season: 22, episode: 7, t: 950 },
    ],
  );
  assert.deepEqual(
    merged.map((c) => c.episode),
    [7, 6],
  );
  assert.equal(merged[0].t, 950);
});

test("the watched checker uses the episode runtime, not a guessed one", () => {
  resumeStore([[`${SERIES}|s5e2`, 10 * 60_000]]);
  const runtime = new Map([
    ["5:2", 20],
    ["5:3", 20],
  ]);
  const watched = makeWatchedChecker(
    [SERIES],
    (season, episode) => runtime.get(`${season}:${episode}`) ?? null,
    new Set<string>(),
    progressFn as never,
  );
  // 10 of 20 minutes is half an episode, not finished.
  assert.equal(watched(5, 2), false);
  assert.equal(watched(5, 3), false);
});

test("unparseable air dates stay resumable", () => {
  assert.equal(isAiredEpisode(undefined, NOW), true);
  assert.equal(isAiredEpisode("not-a-date", NOW), true);
  assert.equal(isAiredEpisode(PAST, NOW), true);
  assert.equal(isAiredEpisode(FUTURE, NOW), false);
});

test("resume entries reject placeholder seasons and episodes", () => {
  assert.equal(isResumeEntry({ season: 0, episode: 4 }), false);
  assert.equal(isResumeEntry({ season: undefined, episode: 4 }), false);
  assert.equal(isResumeEntry({ season: 1, episode: 1 }), true);
});

test("a player-exit resume write notifies subscribers", async () => {
  // use-player-exit.ts only calls saveResumeMs when the player closes; that
  // write has to invalidate the detail page's resume memo even though the
  // Stremio library item and the Continue Watching store are untouched.
  const { saveResumeMs, resumeVersion, subscribeResume } = await import("../src/lib/resume.ts");
  let calls = 0;
  const unsubscribe = subscribeResume(() => {
    calls += 1;
  });
  const before = resumeVersion();
  saveResumeMs(SERIES, 21 * 60_000, 22, 8);
  assert.equal(calls, 1);
  assert.ok(resumeVersion() > before);
  unsubscribe();
  saveResumeMs(SERIES, 21 * 60_000, 22, 9);
  assert.equal(calls, 1);
});

test("the detail page wires the resolver to the shared helpers and state", () => {
  const source = readFileSync(new URL("../src/views/detail.tsx", import.meta.url), "utf8");
  // Selection logic comes from the shared module, not a local re-implementation.
  assert.match(source, /resolveDetailResume\(/);
  assert.match(source, /import \{[\s\S]*resolveDetailResume[\s\S]*\} from "@\/lib\/detail-resume"/);
  // Ordering and progress come from the same helpers the home row uses.
  assert.match(source, /nextUnwatchedAfter,\s*\n\s*getEpisodeProgress,/);
  assert.match(source, /import \{ nextUnwatchedAfter \} from "@\/lib\/series-episodes"/);
  assert.match(source, /import \{ getEpisodeProgress \} from "@\/lib\/episode-progress"/);
  // The resume target must re-derive when local progress changes while this
  // view stays mounted (player exit, manual watched toggle, Continue Watching).
  assert.match(
    source,
    /const localCwVer = useSyncExternalStore\(subscribeLocalCw, localCwVersion\)/,
  );
  assert.match(source, /const resumeVer = useSyncExternalStore\(subscribeResume, resumeVersion\)/);
  assert.match(source, /seriesWatchedVer,/);
  assert.match(source, /localCwVer,/);
  assert.match(source, /resumeVer,/);
});
