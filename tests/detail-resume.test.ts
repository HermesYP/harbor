// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import ts from "typescript";
import {
  isFinishedSeries,
  isPlaybackFinished,
  resolveSeriesResume,
} from "../src/lib/episode-advance.ts";

const source = readFileSync(new URL("../src/views/detail.tsx", import.meta.url), "utf8").replace(
  /\r\n/g,
  "\n",
);
const file = ts.createSourceFile(
  "detail.tsx",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
function declaration(name: string): string {
  let result = "";
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === name) {
      result = `const ${node.getText(file)};`;
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return result;
}
function evaluate(code: string, inputs: Record<string, unknown>) {
  return new Function(
    ...Object.keys(inputs),
    ts.transpile(code, { target: ts.ScriptTarget.ESNext }),
  )(...Object.values(inputs));
}
// Execute the real progress policy, replacing only its storage reads.
const progressSource = readFileSync(
  new URL("../src/lib/episode-progress.ts", import.meta.url),
  "utf8",
)
  .replace(/^import .*;\r?\n/gm, "")
  .replace(/export /g, "");
const getEpisodeProgress = evaluate(progressSource + "\nreturn getEpisodeProgress;", {
  manualWatchedState: () => undefined,
  lastPlayedEpisode: () => null,
  readResumeEntry: () => null,
});
const current = { season: 22, episode: 7 };
const next = { season: 22, episode: 8 };
const episodes = [current, next];
function fixture(overrides: Record<string, unknown> = {}) {
  return {
    useMemo: (fn: () => unknown) => fn(),
    useCallback: (fn: unknown) => fn,
    episodeHint: null,
    isSeries: true,
    isAnime: false,
    meta: { id: "tt0121955" },
    detail: null,
    libraryItem: null,
    localCwEntry: () => ({ type: "series", ...current, t: 1, positionMs: 900, durationMs: 1000 }),
    lastPlayedEpisode: () => null,
    localVersion: 0,
    seriesWatchedVer: 0,
    resumeImdb: "tt0121955",
    resumeEpisodes: { id: "tt0121955", episodes },
    traktWatched: new Set(),
    simklWatched: new Set(),
    stremioWatched: new Set(),
    getEpisodeProgress,
    isFinishedSeries,
    isPlaybackFinished,
    resolveSeriesResume,
    episodeFromVideoId: (id?: string) => {
      const match = id?.match(/:(\d+):(\d+)$/);
      return match ? { season: Number(match[1]), episode: Number(match[2]) } : null;
    },
    ...overrides,
  };
}
function resolve(overrides: Record<string, unknown> = {}) {
  const inputs = fixture(overrides);
  const code =
    declaration("lastPlayed") +
    declaration("resolveResume") +
    declaration("seriesResume") +
    declaration("lastPlay");
  return {
    inputs,
    ...evaluate(code + "return { lastPlay, seriesResume, resolveResume };", inputs),
  };
}
async function play(overrides: Record<string, unknown> = {}, forcePicker = false) {
  const resolved = resolve(overrides);
  const calls: Array<{ episode: unknown; opts: { resume: boolean } }> = [];
  const inputs = {
    ...resolved.inputs,
    ...resolved,
    inSession: false,
    liveContext: false,
    claimHost: () => {},
    settings: { instantPlay: true, localPlaybackMode: "stream" },
    openPicker: (_meta: unknown, episode: unknown, opts: { resume: boolean }) =>
      calls.push({ episode, opts }),
    openPlayer: () => {},
    playMeta: { id: "tt0121955" },
    update: () => {},
    authKey: null,
    cinemetaFull: null,
    animeEpisodes: [{ seasonNumber: 1, number: 3, title: "Anime", streamId: "kitsu:1:3" }],
    playLocalAware: (options: { playStream: () => void }) => options.playStream(),
    t: (label: string, params?: { s: number; e: number }) =>
      params ? label.replace("{s}", String(params.s)).replace("{e}", String(params.e)) : label,
    ...overrides,
  };
  const result = evaluate(
    declaration("smartPlay") +
      declaration("smartPlayLabel") +
      "return { smartPlay, smartPlayLabel };",
    inputs,
  );
  await result.smartPlay(forcePicker);
  return { calls, label: result.smartPlayLabel, resolved };
}

test("episode fetching does not depend on the render-unstable playMeta object", () => {
  assert.doesNotMatch(source, /\[isSeries, isAnime, playMeta, meta.id, settings.tmdbKey\]/);
});

test("detail label and play handler advance S22E7 credits to S22E8", async () => {
  const result = await play();
  assert.equal(result.label, "Resume S22:E8");
  assert.deepEqual(result.calls[0].episode, next);
  assert.equal(result.calls[0].opts.resume, true);
});

test("partial episode and the exact Home completion boundary", async () => {
  for (const [positionMs, expected] of [
    [899, current],
    [900, next],
    [1000, next],
  ] as const) {
    const result = await play({
      localCwEntry: () => ({ type: "series", ...current, t: 1, positionMs, durationMs: 1000 }),
    });
    assert.deepEqual(result.calls[0].episode, expected);
  }
});

test("cloud completion uses Home's flaggedWatched and duration policy", () => {
  for (const [offset, duration, flag, expected] of [
    [899, 1000, 1, current],
    [900, 1000, 1, next],
    [900, 1000, 0, current],
    [1, 0, 1, next],
  ] as const) {
    const result = resolve({
      localCwEntry: () => null,
      libraryItem: {
        type: "series",
        state: { timeOffset: offset, duration, flaggedWatched: flag, video_id: "tt0121955:22:7" },
      },
    });
    assert.deepEqual(result.lastPlay, expected);
  }
});

test("advances across seasons and skips episodes already watched by trackers", async () => {
  const season23 = { season: 23, episode: 1 };
  const result = await play({
    resumeEpisodes: {
      id: "tt0121955",
      episodes: [season23, next, current, { season: 0, episode: 1 }],
    },
    traktWatched: new Set(["imdb:tt0121955:22:8"]),
  });
  assert.equal(result.label, "Resume S23:E1");
  assert.deepEqual(result.calls[0].episode, season23);
});

test("finale, unaired successor, and unavailable metadata replay instead of resuming credits", async () => {
  for (const list of [
    [current],
    [current, { ...next, airDate: "2999-01-01" }],
    [],
    undefined,
    [next],
  ]) {
    const result = await play({
      resumeEpisodes: list ? { id: "tt0121955", episodes: list } : null,
    });
    assert.equal(result.label, "Play");
    assert.deepEqual(result.calls[0].episode, current);
    assert.equal(result.calls[0].opts.resume, false);
  }
});

test("unknown or invalid air dates retain Home's non-anime behavior", () => {
  for (const airDate of [undefined, "invalid", "2000-01-01"]) {
    assert.equal(
      resolve({ resumeEpisodes: { id: "tt0121955", episodes: [current, { ...next, airDate }] } })
        .lastPlay.episode,
      8,
    );
  }
});

test("metadata for a previous title is never used", () => {
  const result = resolve({ resumeEpisodes: { id: "ttOther", episodes } });
  assert.deepEqual(result.lastPlay, current);
  assert.equal(result.seriesResume.completed, true);
});

test("newer partial playback is not overridden by older cloud completion", () => {
  const result = resolve({
    localCwEntry: () => ({
      type: "series",
      ...current,
      t: 2000,
      positionMs: 300,
      durationMs: 1000,
    }),
    libraryItem: {
      type: "series",
      _mtime: new Date(1000).toISOString(),
      state: { ...current, timeOffset: 950, duration: 1000, flaggedWatched: 1 },
    },
  });
  assert.deepEqual(result.lastPlay, current);
  assert.equal(result.seriesResume.completed, false);
});

test("latest resume IDs and hints still select the correct episode", () => {
  assert.deepEqual(
    resolve({
      localCwEntry: () => null,
      detail: { id: 5 },
      lastPlayedEpisode: (id: string) =>
        id === "tmdb:tv:5" ? { ...next, t: 2 } : { ...current, t: 1 },
    }).lastPlay,
    next,
  );
  assert.deepEqual(resolve({ episodeHint: next }).lastPlay, next);
});

test("anime stream mapping, movies, and force-picker behavior are preserved", async () => {
  const anime = await play({ isAnime: true, lastPlayedEpisode: () => ({ season: 1, episode: 3 }) });
  assert.equal((anime.calls[0].episode as { kitsuStreamId: string }).kitsuStreamId, "kitsu:1:3");
  assert.equal(anime.label, "Resume S1:E3");
  const movie = await play({ isSeries: false });
  assert.equal(movie.calls[0].episode, undefined);
  assert.equal(movie.label, "Play");
  const picker = await play({}, true);
  assert.deepEqual(picker.calls[0].episode, next);
  assert.equal(picker.calls[0].opts.resume, false);
});

test("late cloud lookup advances the episode passed to the picker", async () => {
  const result = await play({
    localCwEntry: () => null,
    authKey: "test-key",
    CLOUD_OK: /^tt/,
    libraryGetOne: async () => ({
      type: "series",
      state: { ...current, timeOffset: 900, duration: 1000, flaggedWatched: 1 },
    }),
  });
  assert.deepEqual(result.calls[0].episode, next);
});

test("local playback highlights up-next and restarts a completed finale", async () => {
  let options:
    | { initialSeason: number; highlightEpisode: number; onPlayLocal: (e: unknown) => void }
    | undefined;
  let played: { startFromZero?: boolean } | undefined;
  const overrides = {
    settings: { instantPlay: true, localPlaybackMode: "local" },
    findLocalSeriesEpisodes: () => [{}],
    openLocalEpisodes: (value: typeof options) => {
      options = value;
    },
    localPlayerSrc: () => ({}),
    openPlayer: (value: typeof played) => {
      played = value;
    },
  };
  await play(overrides);
  assert.equal(options?.initialSeason, 22);
  assert.equal(options?.highlightEpisode, 8);
  await play({ ...overrides, resumeEpisodes: { id: "tt0121955", episodes: [current] } });
  options?.onPlayLocal({ season: 22, episode: 7 });
  assert.equal(played?.startFromZero, true);
});

test("cloud watched flags with cleared offsets still resolve up-next", () => {
  const result = resolve({
    localCwEntry: () => null,
    libraryItem: {
      type: "series",
      state: { ...current, timeOffset: 0, duration: 0, flaggedWatched: 1 },
    },
  });
  assert.deepEqual(result.lastPlay, next);
});
