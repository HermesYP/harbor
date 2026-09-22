// @ts-nocheck -- Node's test modules are not included in the application tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { downloadPlayerSrc, findCompletedEpisodeDownload } from "../src/lib/download/player-src.ts";
import type { DownloadItem } from "../src/lib/download/downloads-store.ts";

// Regression coverage for issue #1210: episode navigation always opened the
// stream picker instead of playing a saved copy. What is real here is
// src/lib/download/player-src.ts (pure matcher + PlayerSrc converter) and the
// wiring in the store/hook/DownloadsView. It must not touch the Tauri runtime,
// so the store's module state, localStorage, and Tauri plugin imports are never
// loaded -- only the type-only DownloadItem import and the two pure helpers.

function item(over: Partial<DownloadItem> = {}): DownloadItem {
  return {
    id: "d1",
    metaId: "tt1234567",
    title: "Test Show",
    subtitle: null,
    poster: null,
    season: 1,
    episode: 2,
    streamLabel: null,
    url: "https://example.test/stream",
    path: "/tmp/test-show-s01e02.mkv",
    status: "done",
    receivedBytes: 1024,
    totalBytes: 1024,
    ratio: 1,
    bytesPerSec: 0,
    error: null,
    startedAt: 1000,
    ...over,
  };
}

test("matches only the exact metaId/season/episode combination", () => {
  const target = item({ id: "done-1" });
  const others = [
    item({ id: "other-show", metaId: "tt9999999", season: 1, episode: 2 }),
    item({ id: "other-season", season: 2, episode: 2 }),
    item({ id: "other-episode", season: 1, episode: 3 }),
    item({ id: "movie", season: null, episode: null }),
  ];
  const result = findCompletedEpisodeDownload([target, ...others], "tt1234567", 1, 2);
  assert.equal(result, target);
});

test("returns null when nothing matches exactly", () => {
  const items = [item({ id: "s1e1", episode: 1 }), item({ id: "s2e2", season: 2 })];
  assert.equal(findCompletedEpisodeDownload(items, "tt1234567", 3, 4), null);
  assert.equal(findCompletedEpisodeDownload(items, "other-show", 1, 2), null);
  assert.equal(findCompletedEpisodeDownload([], "tt1234567", 1, 2), null);
});

test("rejects incomplete downloads and prefers a done sibling", () => {
  for (const status of ["downloading", "error", "canceled", "interrupted"]) {
    const d = item({ id: `incomplete-${status}`, status });
    assert.equal(
      findCompletedEpisodeDownload([d], "tt1234567", 1, 2),
      null,
      `status "${status}" must never be returned`,
    );
  }
  const done = item({ id: "done" });
  const dupe = item({ id: "in-flight", status: "downloading" });
  assert.equal(findCompletedEpisodeDownload([done, dupe], "tt1234567", 1, 2), done);
});

test("episode downloads produce the expected PlayerSrc shape", () => {
  const src = downloadPlayerSrc(item({ subtitle: "S01 · E02", poster: "/poster.jpg" }));
  assert.deepEqual(src.meta, {
    id: "tt1234567",
    type: "series",
    name: "Test Show",
    poster: "/poster.jpg",
  });
  assert.equal(src.url, "/tmp/test-show-s01e02.mkv");
  assert.equal(src.title, "Test Show");
  assert.equal(src.subtitle, "S01 · E02");
  assert.equal(src.notWebReady, true);
  assert.deepEqual(src.episode, { season: 1, episode: 2 });
});

test("movie downloads omit episode and null fields", () => {
  const src = downloadPlayerSrc(
    item({ season: null, episode: null, poster: null, subtitle: null }),
  );
  assert.equal(src.meta.type, "movie");
  assert.equal(src.meta.poster, undefined);
  assert.equal(src.episode, undefined);
  assert.equal(src.subtitle, undefined);
});

test("episode navigation prefers a completed download before the picker", () => {
  const source = readFileSync(
    new URL("../src/views/player/hooks/use-episode-navigation.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /import \{[^}]*completedDownloadFor[^}]*\} from "@\/lib\/download\/downloads-store"/,
  );
  assert.match(
    source,
    /import \{[^}]*downloadPlayerSrc[^}]*\} from "@\/lib\/download\/player-src"/,
  );
  assert.match(source, /replacePlayerSrc\(downloadPlayerSrc\(downloaded\)\)/);
  // Guards and the local-library preference keep their existing order: room
  // host check, then local files, then a saved download, then the picker.
  const roomAt = source.indexOf("if (inRoom && !isHost) return;");
  const localAt = source.indexOf("findLocalEpisode(localShowKey, ep.season, ep.episode)");
  const downloadAt = source.indexOf("completedDownloadFor(src.meta.id, ep.season, ep.episode)");
  const pickerAt = source.indexOf("openPicker(src.meta, ep, { autoPlay: true });");
  assert.ok(roomAt >= 0 && roomAt < localAt, "room-host guard stays before local-library");
  assert.ok(
    localAt >= 0 && localAt < downloadAt,
    "local-library preference stays before downloads",
  );
  assert.ok(
    downloadAt >= 0 && downloadAt < pickerAt,
    "completed download is preferred over the picker",
  );
});

test("the store exposes a sync completed lookup over the pure matcher", () => {
  const store = readFileSync(
    new URL("../src/lib/download/downloads-store.ts", import.meta.url),
    "utf8",
  );
  assert.match(store, /export function completedDownloadFor\(/);
  assert.match(
    store,
    /findCompletedEpisodeDownload\(\[\.\.\.items\.values\(\)\], metaId, season, episode\)/,
  );
  const pure = readFileSync(new URL("../src/lib/download/player-src.ts", import.meta.url), "utf8");
  assert.match(pure, /d\.status !== "done"/);
  assert.match(pure, /d\.season !== season \|\| d\.episode !== episode/);
});

test("DownloadsView plays through the shared converter", () => {
  const view = readFileSync(new URL("../src/views/downloads.tsx", import.meta.url), "utf8");
  assert.match(view, /import \{[^}]*downloadPlayerSrc[^}]*\} from "@\/lib\/download\/player-src"/);
  assert.match(view, /openPlayer\(downloadPlayerSrc\(d\)\)/);
});
