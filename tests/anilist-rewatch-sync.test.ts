// @ts-nocheck -- Node's test modules are not included in the application tsconfig.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { decideAnimeProgress } from "../src/lib/anilist/progress-decision.ts";
import {
  ENTRY_QUERY,
  PROGRESS_MUTATION,
  createProgressSyncDeps,
  runAnimeProgressSync,
} from "../src/lib/anilist/progress-sync.ts";

/**
 * Minimal AniList stand-in: one list entry per media, holding exactly the
 * fields the sync reads. A write applies the progress it was given (clamped to
 * the episode total), the status it was given, and the repeat value it was
 * given or the stored one — so the tests exercise Harbor's decisions rather
 * than the fake's.
 */
function createAniList(initial) {
  const entries = new Map(
    Object.entries(initial).map(([mediaId, entry]) => [Number(mediaId), { id: 900, ...entry }]),
  );
  const writes = [];

  const handle = (query, variables) => {
    const mediaId = Number(variables.mediaId ?? variables.id);
    const stored = entries.get(mediaId) ?? null;
    if (query === ENTRY_QUERY) {
      return {
        Media: {
          id: mediaId,
          episodes: stored?.total ?? null,
          mediaListEntry: stored
            ? {
                id: stored.id,
                progress: stored.progress,
                status: stored.status,
                repeat: stored.repeat,
              }
            : null,
        },
      };
    }
    if (query !== PROGRESS_MUTATION) throw new Error(`unexpected query: ${query}`);

    writes.push({ mediaId, ...variables });

    const total = stored?.total ?? null;
    const progress =
      variables.progress == null
        ? (stored?.progress ?? 0)
        : total != null
          ? Math.min(variables.progress, total)
          : variables.progress;
    const next = {
      id: stored?.id ?? 900,
      total,
      progress,
      status: variables.status ?? stored?.status ?? "CURRENT",
      repeat: variables.repeat ?? stored?.repeat ?? 0,
    };
    entries.set(mediaId, next);
    return {
      SaveMediaListEntry: {
        id: next.id,
        progress: next.progress,
        status: next.status,
        repeat: next.repeat,
      },
    };
  };

  return {
    entries,
    writes,
    /** What the user changing the entry on AniList itself looks like. */
    setEntry: (mediaId, patch) => entries.set(mediaId, { ...entries.get(mediaId), ...patch }),
    request: async (query, variables) => handle(query, variables),
  };
}

const depsFor = (server, extra = {}) => ({
  getToken: () => "token",
  request: server.request,
  emit: () => {},
  ...extra,
});

const entryOf = (server, mediaId) => server.entries.get(mediaId);

test("a first run walks progress to the total and completes without a repeat", async () => {
  const server = createAniList({ 21: { total: 12, progress: 0, status: "CURRENT", repeat: 0 } });
  const deps = depsFor(server);

  await runAnimeProgressSync(21, 1, deps);
  assert.deepEqual(server.writes, [{ mediaId: 21, progress: 1, status: "CURRENT" }]);

  await runAnimeProgressSync(21, 12, deps);
  assert.deepEqual(server.writes.at(-1), { mediaId: 21, progress: 12, status: "COMPLETED" });
  assert.equal(entryOf(server, 21).status, "COMPLETED");
  assert.equal(entryOf(server, 21).repeat, 0);
});

test("finishing a series AniList reports as COMPLETED writes nothing", async () => {
  // Regression for #1380: a finished series is never pushed as watched again,
  // and Harbor does not start a rewatch on the user's behalf.
  const server = createAniList({ 21: { total: 12, progress: 12, status: "COMPLETED", repeat: 0 } });

  for (const episode of [1, 6, 12, 12]) {
    await runAnimeProgressSync(21, episode, depsFor(server));
  }

  assert.deepEqual(server.writes, []);
  assert.equal(entryOf(server, 21).repeat, 0);
  assert.equal(entryOf(server, 21).progress, 12);
});

test("a rewatch reported by AniList advances and completes with one repeat", async () => {
  const server = createAniList({ 21: { total: 12, progress: 1, status: "REPEATING", repeat: 1 } });
  const deps = depsFor(server);

  await runAnimeProgressSync(21, 2, deps);
  assert.deepEqual(server.writes, [{ mediaId: 21, progress: 2, status: "REPEATING" }]);

  await runAnimeProgressSync(21, 12, deps);
  assert.deepEqual(server.writes.at(-1), {
    mediaId: 21,
    progress: 12,
    status: "COMPLETED",
    repeat: 2,
  });
  assert.equal(entryOf(server, 21).status, "COMPLETED");
  assert.equal(entryOf(server, 21).repeat, 2);
});

test("setting REPEATING and playing the finale counts the rewatch without interim episodes", async () => {
  // The reported shape of #1380: the first run finished at repeat 1, then the
  // user marks the series as rewatching on AniList (status REPEATING, progress
  // reset, repeat still 1) and plays the final episode directly.
  const server = createAniList({ 21: { total: 12, progress: 12, status: "COMPLETED", repeat: 1 } });
  server.setEntry(21, { status: "REPEATING", progress: 0, repeat: 1 });

  await runAnimeProgressSync(21, 12, depsFor(server));

  assert.deepEqual(server.writes, [{ mediaId: 21, progress: 12, status: "COMPLETED", repeat: 2 }]);
  assert.equal(entryOf(server, 21).repeat, 2);
  assert.equal(entryOf(server, 21).status, "COMPLETED");
});

test("a first rewatch of a series AniList reports without a repeat counts one", async () => {
  // `repeat` is nullable in the API, so a never-rewatched entry reports null.
  const server = createAniList({
    21: { total: 12, progress: 3, status: "REPEATING", repeat: null },
  });

  await runAnimeProgressSync(21, 12, depsFor(server));

  assert.deepEqual(server.writes, [{ mediaId: 21, progress: 12, status: "COMPLETED", repeat: 1 }]);
  assert.equal(entryOf(server, 21).repeat, 1);
});

test("a replayed finale after completing writes the same repeat, not a second bump", async () => {
  const server = createAniList({ 21: { total: 12, progress: 1, status: "REPEATING", repeat: 1 } });
  const deps = depsFor(server);

  await runAnimeProgressSync(21, 12, deps);
  assert.equal(entryOf(server, 21).repeat, 2);

  // The player reports the same finale again while AniList already completed
  // the run: nothing further is written.
  await runAnimeProgressSync(21, 12, deps);
  await runAnimeProgressSync(21, 12, deps);
  assert.equal(server.writes.length, 1);
  assert.equal(entryOf(server, 21).repeat, 2);
});

test("a stale server that still reports the pre-completion state writes one repeat", async () => {
  // AniList has not caught up with the repeat the app already asked for: the
  // request carries the absolute value, so repeating it is idempotent.
  const server = createAniList({ 21: { total: 12, progress: 11, status: "REPEATING", repeat: 1 } });
  const deps = depsFor(server);

  await runAnimeProgressSync(21, 12, deps);
  assert.deepEqual(server.writes, [{ mediaId: 21, progress: 12, status: "COMPLETED", repeat: 2 }]);

  server.setEntry(21, { status: "REPEATING", progress: 11, repeat: 1 });
  await runAnimeProgressSync(21, 12, deps);
  assert.deepEqual(server.writes.at(-1), {
    mediaId: 21,
    progress: 12,
    status: "COMPLETED",
    repeat: 2,
  });
});

test("progress never regresses and unknown totals never invent rewatches", async () => {
  const partial = createAniList({ 21: { total: 24, progress: 7, status: "CURRENT", repeat: 0 } });
  await runAnimeProgressSync(21, 3, depsFor(partial));
  assert.deepEqual(partial.writes, []);
  assert.equal(entryOf(partial, 21).progress, 7);

  const unknown = createAniList({ 30: { total: null, progress: 4, status: "CURRENT", repeat: 0 } });
  await runAnimeProgressSync(30, 5, depsFor(unknown));
  await runAnimeProgressSync(30, 4, depsFor(unknown));
  assert.deepEqual(unknown.writes, [{ mediaId: 30, progress: 5, status: "CURRENT" }]);
  assert.equal(entryOf(unknown, 30).repeat, 0);

  const unknownRewatch = createAniList({
    31: { total: null, progress: 4, status: "REPEATING", repeat: 1 },
  });
  await runAnimeProgressSync(31, 9, depsFor(unknownRewatch));
  assert.deepEqual(unknownRewatch.writes, [{ mediaId: 31, progress: 9, status: "REPEATING" }]);
  assert.equal(entryOf(unknownRewatch, 31).repeat, 1);
});

test("a fresh entry collects forward progress without a repeat", async () => {
  const server = createAniList({});
  await runAnimeProgressSync(21, 3, depsFor(server));
  assert.deepEqual(server.writes, [{ mediaId: 21, progress: 3, status: "CURRENT" }]);
  assert.equal(entryOf(server, 21).repeat, 0);
});

test("a season-relative episode number is clamped to the known total", async () => {
  const server = createAniList({ 21: { total: 12, progress: 0, status: "CURRENT", repeat: 0 } });
  await runAnimeProgressSync(21, 25, depsFor(server));
  assert.deepEqual(server.writes, [{ mediaId: 21, progress: 12, status: "COMPLETED" }]);
  assert.equal(entryOf(server, 21).repeat, 0);
});

test("decideAnimeProgress leaves completed entries alone and only rewatches REPEATING", () => {
  // Any finished episode on a completed entry is skipped, with no write shape
  // that could re-mark it or move the repeat counter.
  for (const episode of [1, 6, 11, 12, 25]) {
    assert.deepEqual(
      decideAnimeProgress({ status: "COMPLETED", progress: 12, repeat: 2 }, episode, 12),
      { action: "skip", reason: "completed" },
    );
  }
  assert.deepEqual(decideAnimeProgress({ status: "COMPLETED", progress: 12, repeat: 0 }, 1, 0), {
    action: "skip",
    reason: "completed",
  });

  const run = { status: "CURRENT", progress: 5, repeat: 0 };
  assert.deepEqual(decideAnimeProgress(run, 6, 12), {
    action: "update",
    progress: 6,
    status: "CURRENT",
  });
  assert.deepEqual(decideAnimeProgress(run, 12, 12), {
    action: "update",
    progress: 12,
    status: "COMPLETED",
  });
  assert.equal(decideAnimeProgress(run, 12, 12).repeat, undefined);
  assert.deepEqual(decideAnimeProgress(run, 4, 12), { action: "skip", reason: "episode-latest" });

  const rewatch = { status: "REPEATING", progress: 4, repeat: 1 };
  assert.deepEqual(decideAnimeProgress(rewatch, 5, 12), {
    action: "update",
    progress: 5,
    status: "REPEATING",
  });
  assert.deepEqual(decideAnimeProgress(rewatch, 12, 12), {
    action: "update",
    progress: 12,
    status: "COMPLETED",
    repeat: 2,
  });
  // The repeat is always one past what the live entry reports, so a value the
  // server has already caught up to is written again unchanged.
  assert.deepEqual(decideAnimeProgress({ status: "REPEATING", progress: 1, repeat: 4 }, 12, 12), {
    action: "update",
    progress: 12,
    status: "COMPLETED",
    repeat: 5,
  });
  // AniList reports `repeat` as nullable, and a first rewatch starts from null.
  assert.deepEqual(
    decideAnimeProgress({ status: "REPEATING", progress: 1, repeat: null }, 12, 12),
    {
      action: "update",
      progress: 12,
      status: "COMPLETED",
      repeat: 1,
    },
  );

  assert.deepEqual(decideAnimeProgress(null, 1, 12), {
    action: "update",
    progress: 1,
    status: "CURRENT",
  });
  // Unknown totals stay forward only, so they can never complete or repeat.
  assert.deepEqual(decideAnimeProgress({ status: "CURRENT", progress: 4, repeat: 0 }, 5, 0), {
    action: "update",
    progress: 5,
    status: "CURRENT",
  });
  assert.deepEqual(decideAnimeProgress({ status: "REPEATING", progress: 4, repeat: 1 }, 9, 0), {
    action: "update",
    progress: 9,
    status: "REPEATING",
  });
});

test("the adapter uses the token it was bound to and the injected request", async () => {
  const server = createAniList({ 21: { total: 12, progress: 1, status: "REPEATING", repeat: 1 } });
  const tokens = [];
  const events = [];
  const deps = createProgressSyncDeps({
    token: "token-alice",
    request: (query, variables, token) => {
      tokens.push(token);
      return server.request(query, variables);
    },
    emit: (event) => events.push(event),
  });

  assert.equal(deps.getToken(), "token-alice");
  await runAnimeProgressSync(21, 2, deps);
  assert.deepEqual(tokens, ["token-alice", "token-alice"]);
  assert.deepEqual(events, [
    { kind: "syncing", episode: 2 },
    { kind: "ok", episode: 2 },
  ]);
});

test("a profile switch during the entry read cancels the write", async () => {
  const server = createAniList({ 21: { total: 12, progress: 1, status: "REPEATING", repeat: 1 } });
  let stillValid = true;
  const deps = createProgressSyncDeps({
    token: "token-alice",
    request: async (query, variables) => {
      stillValid = false; // the account changed while the entry was read
      return server.request(query, variables);
    },
    isStillValid: () => stillValid,
    emit: () => {},
  });

  await runAnimeProgressSync(21, 2, deps);
  assert.deepEqual(server.writes, []);
});

test("a failed write reports an error and is never counted as ok", async () => {
  const events = [];
  const deps = createProgressSyncDeps({
    token: "token-alice",
    request: async (query) =>
      query === ENTRY_QUERY
        ? {
            Media: {
              id: 21,
              episodes: 12,
              mediaListEntry: { id: 5, progress: 1, status: "REPEATING", repeat: 1 },
            },
          }
        : { SaveMediaListEntry: null },
    emit: (event) => events.push(event),
  });

  await runAnimeProgressSync(21, 12, deps);
  assert.deepEqual(events, [
    { kind: "syncing", episode: 12 },
    { kind: "error", message: "AniList did not confirm the update." },
  ]);
});

test("a write AniList answers differently is not confirmed", async () => {
  const entry = {
    Media: {
      id: 21,
      episodes: 12,
      mediaListEntry: { id: 5, progress: 1, status: "REPEATING", repeat: 1 },
    },
  };
  const runWith = async (save) => {
    const events = [];
    const deps = createProgressSyncDeps({
      token: "token-alice",
      request: async (query) => (query === ENTRY_QUERY ? entry : save),
      emit: (event) => events.push(event),
    });
    await runAnimeProgressSync(21, 12, deps);
    return events;
  };

  const error = [
    { kind: "syncing", episode: 12 },
    { kind: "error", message: "AniList did not confirm the update." },
  ];

  // Progress came back lower than requested.
  assert.deepEqual(
    await runWith({
      SaveMediaListEntry: { id: 5, progress: 11, status: "COMPLETED", repeat: 2 },
    }),
    error,
  );
  // The status was not applied.
  assert.deepEqual(
    await runWith({
      SaveMediaListEntry: { id: 5, progress: 12, status: "REPEATING", repeat: 2 },
    }),
    error,
  );
  // The rewatch counter was not moved to the requested value.
  assert.deepEqual(
    await runWith({
      SaveMediaListEntry: { id: 5, progress: 12, status: "COMPLETED", repeat: 1 },
    }),
    error,
  );
  // The entry itself is missing from the response payload.
  assert.deepEqual(await runWith({}), error);

  // The exact requested state is confirmed.
  assert.deepEqual(
    await runWith({
      SaveMediaListEntry: { id: 5, progress: 12, status: "COMPLETED", repeat: 2 },
    }),
    [
      { kind: "syncing", episode: 12 },
      { kind: "ok", episode: 12 },
    ],
  );
});

test("the production wiring attaches the bound token and re-checks the account", async () => {
  // `sync.ts` reaches into the app's alias graph, so Node cannot import it.
  // Assert on its source that the exposed adapter is wired as documented.
  const source = await readFile(new URL("../src/lib/anilist/sync.ts", import.meta.url), "utf8");
  assert.match(source, /createProgressSyncDeps\(\{/);
  // A fourth argument is the client's `skipAuth`, which nulls the token
  // (client.ts: `skipAuth ? null : accessToken ?? …`) and writes anonymously.
  assert.match(source, /anilistRequest\(query, variables, requestToken\)/);
  assert.doesNotMatch(source, /requestToken\s*,\s*true/);
  assert.doesNotMatch(source, /anilistRequest\([^)]*,\s*true\s*\)/);
  assert.match(
    source,
    /isStillValid: \(\) =>\s*isAuthenticated\(\) &&\s*activeProfileId\(\) === profileId &&\s*getSession\(\)\?\.accessToken === token/,
  );
  assert.match(source, /if \(activeProfileId\(\) !== profileId\) return;/);
  assert.match(source, /getSession\(\)\?\.accessToken !== token\) return;/);
});
