// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import "./_localstorage-stub.ts";
import {
  PROFILE_LISTS_QUERY,
  PROFILE_LIST_MAX_ITEMS,
  buildProfileLists,
  profileListsCacheKey,
  readCachedProfileLists,
  resetProfileLists,
  writeCachedProfileLists,
  type ProfileListGroup,
} from "../src/lib/anilist/profile-lists.ts";

function media(id: number, idMal: number | null, format: string | null = "TV") {
  return {
    id,
    idMal,
    title: {
      romaji: `Romaji ${id}`,
      english: `English ${id}`,
      native: null,
      userPreferred: `UP ${id}`,
    },
    coverImage: { extraLarge: `https://img.test/${id}.jpg`, large: null, medium: null },
    bannerImage: null,
    format,
    episodes: 12,
    averageScore: 80,
    seasonYear: 2024,
  };
}

function group(over: Partial<ProfileListGroup>): ProfileListGroup {
  return { status: null, name: null, isCustomList: false, entries: [], ...over };
}

function entry(id: number, mediaValue: ReturnType<typeof media>, isPrivate = false) {
  return { id, private: isPrivate, media: mediaValue };
}

test("mapping: status lists get readable fallback names and map entries to featured items", () => {
  const lists = buildProfileLists([
    group({ status: "CURRENT", entries: [entry(1, media(10, 44)), entry(2, media(11, null))] }),
  ]);
  assert.equal(lists.length, 1);
  assert.equal(lists[0].name, "Watching");
  // idMal is preferred so the featured item opens through the shared mal pipeline
  assert.equal(lists[0].items[0].id, "mal:44");
  assert.equal(lists[0].items[1].id, "anilist:11");
  assert.equal(lists[0].items[0].name, "English 10");
  assert.equal(lists[0].items[0].poster, "https://img.test/10.jpg");
  assert.equal(lists[0].items[0].type, "series");
});

test("mapping: custom lists use their AniList name and movies map to movie type", () => {
  const lists = buildProfileLists([
    group({
      name: "  Best OVAs  ",
      isCustomList: true,
      entries: [entry(1, media(20, null, "MOVIE"))],
    }),
  ]);
  assert.equal(lists.length, 1);
  assert.equal(lists[0].name, "Best OVAs");
  assert.equal(lists[0].items[0].type, "movie");
  assert.match(lists[0].id, /^anilist:\d+:best-ovas$/);
});

test("mapping: private entries never reach the featured payload", () => {
  const lists = buildProfileLists([
    group({ name: "Secret", isCustomList: true, entries: [entry(1, media(30), true)] }),
  ]);
  assert.deepEqual(lists, []);
});

test("mapping: a media appears once per list and lists cap at the featured item budget", () => {
  const dupes = [entry(1, media(40)), entry(2, media(40))];
  const many = Array.from({ length: PROFILE_LIST_MAX_ITEMS + 6 }, (_, i) =>
    entry(100 + i, media(1000 + i)),
  );
  const lists = buildProfileLists([
    group({ name: "Dupes", isCustomList: true, entries: dupes }),
    group({ name: "Long", isCustomList: true, entries: many }),
  ]);
  assert.equal(lists[0].items.length, 1);
  assert.equal(lists[1].items.length, PROFILE_LIST_MAX_ITEMS);
});

test("mapping: empty groups and nameless non-status groups are dropped", () => {
  const lists = buildProfileLists([group({ status: null, name: null, entries: [] })]);
  assert.deepEqual(lists, []);
});

test("query: the profile-lists query asks for the privacy and naming fields the mapper reads", () => {
  assert.match(PROFILE_LISTS_QUERY, /MediaListCollection\(userId: \$userId, type: ANIME\)/);
  assert.match(PROFILE_LISTS_QUERY, /\bname\b/);
  assert.match(PROFILE_LISTS_QUERY, /\bisCustomList\b/);
  assert.match(PROFILE_LISTS_QUERY, /\bprivate\b/);
  assert.match(PROFILE_LISTS_QUERY, /\bidMal\b/);
});

test("cache: stored lists round-trip per AniList user and corrupted payloads are dropped", () => {
  resetProfileLists();
  const lists = buildProfileLists([
    group({ name: "Faves", isCustomList: true, entries: [entry(1, media(50))] }),
  ]);
  writeCachedProfileLists(111, lists);
  assert.deepEqual(readCachedProfileLists(111), lists);
  localStorage.setItem(profileListsCacheKey(222), "{not json");
  assert.equal(readCachedProfileLists(222), null);
  localStorage.setItem(profileListsCacheKey(333), JSON.stringify({ lists: "nope" }));
  assert.equal(readCachedProfileLists(333), null);
});

test("account-switch: one account's cached lists are never served to another", () => {
  resetProfileLists();
  const mine = buildProfileLists([
    group({ name: "Mine", isCustomList: true, entries: [entry(1, media(60))] }),
  ]);
  writeCachedProfileLists(111, mine);
  assert.equal(readCachedProfileLists(222), null);
  // clearing the memory layer must not move data between accounts either
  resetProfileLists();
  assert.deepEqual(readCachedProfileLists(111), mine);
  assert.equal(readCachedProfileLists(222), null);
});

test("account-switch: lists.ts fetches with the shared query, caches per user, and resets with the profile", () => {
  const src = readFileSync(new URL("../src/lib/anilist/lists.ts", import.meta.url), "utf8");
  assert.match(src, /anilistRequest<ProfileListsResponse>\(PROFILE_LISTS_QUERY, \{ userId \}\)/);
  assert.match(src, /return readCachedProfileLists\(userId\) \?\? \[\];/);
  assert.match(src, /writeCachedProfileLists\(userId, lists\);/);
  assert.match(src, /resetProfileLists\(\);/);
  // 401 triggers a session revalidation instead of surfacing a raw failure
  assert.match(
    src,
    /e instanceof AnilistApiError && e\.status === 401\) void validateAnilistSession\(\)/,
  );

  const bridge = readFileSync(
    new URL("../src/lib/tracker-profile-bridge.tsx", import.meta.url),
    "utf8",
  );
  assert.match(bridge, /resetForProfile as resetAnilistLists/);
  assert.match(bridge, /resetAnilistLists\(\);/);
});

test("picker: AniList lists join the pickable set used for matching and saving", () => {
  const src = readFileSync(
    new URL("../src/views/profile/my-lists-picker.tsx", import.meta.url),
    "utf8",
  );
  assert.match(src, /fetchProfileLists\(anilistUserId\)/);
  assert.match(src, /readCachedProfileLists\(anilistUserId\)/);
  assert.match(src, /\[\.\.\.local\.map\(toPickableList\), \.\.\.anilist\]/);
  assert.match(src, /matchSelection\(featured, pickable\)/);
  // the AniList request is scoped to the connected owner's own userId only
  assert.doesNotMatch(src, /fetchProfileLists\((?!anilistUserId)/);
});
