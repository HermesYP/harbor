// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { registerHooks } from "node:module";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test, { type TestContext } from "node:test";

const writes: Array<{
  id: string;
  episodes: Array<{ season: number; episode: number }>;
  watched: boolean;
}> = [];
const metadata: string[] = [];
const synced: unknown[][] = [];
const removed: unknown[][] = [];
const mocks = {
  react: { useMemo: (fn: () => unknown) => fn(), useCallback: (fn: unknown) => fn },
  "@/lib/manual-watched": {
    recordManualWatchedMeta: (id: string) => metadata.push(id),
    setManualWatchedMany: (
      id: string,
      episodes: Array<{ season: number; episode: number }>,
      watched: boolean,
    ) => writes.push({ id, episodes, watched }),
  },
  "@/lib/simkl/history": {
    markEpisodesWatched: (...args: unknown[]) => {
      synced.push(args);
      return Promise.resolve();
    },
    unmarkEpisodeWatched: (...args: unknown[]) => {
      removed.push(args);
      return Promise.resolve();
    },
  },
  "@/lib/simkl/ids": {
    stremioIdToSimklTarget: () => ({
      ok: true,
      target: { kind: "episode", show: { ids: { imdb: "tt123" } } },
    }),
  },
};
// Test only the real bulk actions; replace React and persistence/network boundaries.
Object.assign(globalThis, { __markSeasonMocks: mocks });
registerHooks({
  resolve(
    specifier: string,
    context: { parentURL?: string },
    nextResolve: (specifier: string, context: unknown) => unknown,
  ) {
    if (specifier in mocks) return { url: `mock:${specifier}`, shortCircuit: true };
    if (specifier.startsWith("@/")) {
      return nextResolve(new URL(`../src/${specifier.slice(2)}.ts`, import.meta.url).href, context);
    }
    if (
      specifier.startsWith(".") &&
      !specifier.endsWith(".ts") &&
      context.parentURL?.includes("/src/")
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
  load(url: string, context: unknown, nextLoad: (url: string, context: unknown) => unknown) {
    if (!url.startsWith("mock:")) return nextLoad(url, context);
    const name = url.slice(5) as keyof typeof mocks;
    return {
      format: "module",
      source: Object.keys(mocks[name])
        .map(
          (key) =>
            `export const ${key} = globalThis.__markSeasonMocks[${JSON.stringify(name)}].${key};`,
        )
        .join("\n"),
      shortCircuit: true,
    };
  },
});

const { useAnimeWatchedRouting } =
  await import("../src/views/detail/anime-episodes/use-anime-watched-routing.ts");
const { useMarkSeason } = await import("../src/views/detail/series-episodes/use-mark-season.ts");
const meta = { id: "kitsu:123", type: "series", name: "Test show" };
function seriesEpisode(episodeNumber: number, airDate: string | null) {
  return {
    id: episodeNumber,
    episodeNumber,
    seasonNumber: 1,
    name: `Episode ${episodeNumber}`,
    overview: "",
    still: null,
    airDate,
    runtime: 24,
    voteAverage: 0,
  };
}
function animeEpisode(number: number, airdate: string | null) {
  return {
    id: number,
    number,
    seasonNumber: 1,
    title: `Episode ${number}`,
    synopsis: "",
    thumbnail: null,
    airdate,
    length: 24,
  };
}
function reset() {
  writes.length = 0;
  metadata.length = 0;
  synced.length = 0;
  removed.length = 0;
}

test("anime Mark All writes only released episodes, not upcoming or unknown placeholders", (t: TestContext) => {
  reset();
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-18T12:00:00Z") });
  const routing = useAnimeWatchedRouting(meta, []);
  routing.markMany(
    [
      animeEpisode(17, "2026-09-01"),
      animeEpisode(18, "2026-09-19"),
      animeEpisode(21, null),
      animeEpisode(22, "invalid"),
    ],
    true,
  );
  assert.deepEqual(writes, [
    { id: meta.id, episodes: [{ season: 1, episode: 17 }], watched: true },
  ]);
  assert.deepEqual(metadata, [meta.id]);
});

test("series Mark All filters both local writes and Simkl sync at the release instant", (t: TestContext) => {
  reset();
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-18T12:00:00Z") });
  useMarkSeason({
    meta,
    active: 1,
    simklConnected: true,
    enrichedEpisodes: [
      seriesEpisode(1, "2026-09-18T11:59:59.999Z"),
      seriesEpisode(2, "2026-09-18T12:00:00Z"),
      seriesEpisode(3, "2026-09-18T12:00:00.001Z"),
      seriesEpisode(4, null),
    ],
  })(true);
  assert.deepEqual(writes, [
    {
      id: meta.id,
      episodes: [
        { season: 1, episode: 1 },
        { season: 1, episode: 2 },
      ],
      watched: true,
    },
  ]);
  assert.deepEqual(synced, [[{ imdb: "tt123" }, 1, [1, 2]]]);
});

test("a fully aired season is unaffected and Mark as unwatched clears every episode", (t: TestContext) => {
  reset();
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-18T12:00:00Z") });
  useMarkSeason({
    meta,
    active: 1,
    simklConnected: true,
    enrichedEpisodes: [seriesEpisode(1, "2026-09-01"), seriesEpisode(2, "2026-08-01")],
  })(true);
  assert.deepEqual(writes, [
    {
      id: meta.id,
      episodes: [
        { season: 1, episode: 1 },
        { season: 1, episode: 2 },
      ],
      watched: true,
    },
  ]);
  assert.deepEqual(synced, [[{ imdb: "tt123" }, 1, [1, 2]]]);
  writes.length = 0;
  useMarkSeason({
    meta,
    active: 1,
    simklConnected: true,
    enrichedEpisodes: [seriesEpisode(1, "2026-09-20"), seriesEpisode(2, null)],
  })(false);
  assert.deepEqual(writes, [
    {
      id: meta.id,
      episodes: [
        { season: 1, episode: 1 },
        { season: 1, episode: 2 },
      ],
      watched: false,
    },
  ]);
  assert.deepEqual(removed, [
    [{ imdb: "tt123" }, 1, 1],
    [{ imdb: "tt123" }, 1, 2],
  ]);
});

test("an all-upcoming season produces no metadata, local writes, or sync", (t: TestContext) => {
  reset();
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-18T12:00:00Z") });
  useMarkSeason({
    meta,
    active: 1,
    simklConnected: true,
    enrichedEpisodes: [seriesEpisode(1, "2026-09-19"), seriesEpisode(2, null)],
  })(true);
  useAnimeWatchedRouting(meta, []).markMany(
    [animeEpisode(1, "2026-09-19"), animeEpisode(2, null)],
    true,
  );
  assert.deepEqual(writes, []);
  assert.deepEqual(metadata, []);
  assert.deepEqual(synced, []);
});

test("date-only air dates use local midnight rather than UTC midnight", (t: TestContext) => {
  reset();
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 8, 18, 0, 0, 0) });
  useAnimeWatchedRouting(meta, []).markMany(
    [animeEpisode(1, "2026-09-17"), animeEpisode(2, "2026-09-18"), animeEpisode(3, "2026-09-19")],
    true,
  );
  assert.deepEqual(writes, [
    {
      id: meta.id,
      episodes: [
        { season: 1, episode: 1 },
        { season: 1, episode: 2 },
      ],
      watched: true,
    },
  ]);
});

test("timestamp offsets are compared as instants, not calendar strings", (t: TestContext) => {
  reset();
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-18T00:00:00Z") });
  useAnimeWatchedRouting(meta, []).markMany(
    [
      animeEpisode(1, "2026-09-18T05:30:00+05:30"),
      animeEpisode(2, "2026-09-17T20:00:00-04:00"),
      animeEpisode(3, "2026-09-17T23:00:00-04:00"),
    ],
    true,
  );
  assert.deepEqual(writes, [
    {
      id: meta.id,
      episodes: [
        { season: 1, episode: 1 },
        { season: 1, episode: 2 },
      ],
      watched: true,
    },
  ]);
});

test("anime bulk marking preserves franchise IDs and season keys", (t: TestContext) => {
  reset();
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-18T12:00:00Z") });
  useAnimeWatchedRouting(meta, []).markMany(
    [
      animeEpisode(1, "2026-09-01"),
      { ...animeEpisode(2, "2026-09-02"), id: -2, sourceMetaId: "kitsu:456", imdbSeason: 2 },
      { ...animeEpisode(3, "2026-09-19"), sourceMetaId: "kitsu:456" },
    ],
    true,
  );
  assert.deepEqual(writes, [
    { id: meta.id, episodes: [{ season: 1, episode: 1 }], watched: true },
    { id: "kitsu:456", episodes: [{ season: 2, episode: 2 }], watched: true },
  ]);
});

test("anime bulk unmarking can clear previously marked future and undated episodes", () => {
  reset();
  useAnimeWatchedRouting(meta, []).markMany(
    [animeEpisode(1, "2099-09-19"), animeEpisode(2, null)],
    false,
  );
  assert.deepEqual(writes, [
    {
      id: meta.id,
      episodes: [
        { season: 1, episode: 1 },
        { season: 1, episode: 2 },
      ],
      watched: false,
    },
  ]);
  assert.deepEqual(metadata, []);
});
