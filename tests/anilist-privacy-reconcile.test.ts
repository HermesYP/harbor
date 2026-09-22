// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import "./_localstorage-stub.ts";
import {
  buildProfileLists,
  profileListGroupNames,
  readCachedProfileListNames,
  resetProfileLists,
  writeCachedProfileLists,
  type ProfileListGroup,
} from "../src/lib/anilist/profile-lists.ts";
import { fetchProfileLists, resetForProfile } from "../src/lib/anilist/lists.ts";
import {
  buildFeaturedPayload,
  featuredWirePayload,
  type FeaturedList,
  type PickableList,
} from "../src/lib/social/featured-lists.ts";
import {
  UNVERIFIED_PRIVACY,
  buildGhosts,
  hasUnprovenSelection,
  isPublishable,
  isSaveReady,
  matchSelection,
  publishableSelection,
  reconcileFeatured,
  type FeaturedPrivacy,
} from "../src/lib/social/featured-reconcile.ts";

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

function item(id: string) {
  return { id, name: `Title ${id}`, poster: "", type: "series" };
}

const VERIFIED: FeaturedPrivacy = {
  anilistNames: [],
  anilistVerified: true,
  anilistConnected: true,
};

test("private-empty: an all-private AniList list never re-enters the payload and blocks Save until it is removed", () => {
  const groups = [
    group({ name: "Secret", isCustomList: true, entries: [entry(1, media(30), true)] }),
    group({ name: "Public", isCustomList: true, entries: [entry(2, media(31))] }),
  ];
  const candidates = buildProfileLists(groups);
  // Only the public list is a candidate — but the all-private list's NAME
  // still surfaces for privacy reconciliation.
  assert.deepEqual(
    candidates.map((l) => l.name),
    ["Public"],
  );
  assert.deepEqual(profileListGroupNames(groups), ["Secret", "Public"]);

  // Invariant core below is independent of how served rows are matched to
  // candidates (name matching today, identity claims after the merge): it
  // only relies on provenance and the AniList item signature.
  const privacy: FeaturedPrivacy = {
    anilistNames: [],
    anilistVerified: true,
    anilistConnected: true,
  };
  const entries: PickableList[] = [
    ...candidates,
    { id: "srv:s-secret", name: "Secret", items: [item("mal:9")] },
    { id: "srv:s-local", name: "Local faves", items: [item("tt1000001")] },
    { id: "local-faves", name: "Other", items: [item("tt1000002")], source: "local" },
  ];
  const selected = entries.map((e) => e.id);

  // Stale items of the all-private list are never publishable (AniList
  // signature, even with no name knowledge), so Save blocks instead of
  // silently dropping or silently republishing the row.
  assert.equal(isPublishable(entries[1], privacy), false);
  assert.equal(hasUnprovenSelection(entries, selected, privacy), true);
  assert.ok(
    !publishableSelection(entries, selected, privacy).some((l) => l.name === "Secret"),
    "never republish the now-private entries",
  );

  // The user explicitly removes the row -> Save unblocks and it stays unfeatured.
  const after = selected.filter((id) => id !== "srv:s-secret");
  assert.equal(hasUnprovenSelection(entries, after, privacy), false);
  const payload = publishableSelection(entries, after, privacy);
  assert.deepEqual(payload.map((l) => l.name).sort(), ["Local faves", "Other", "Public"].sort());
});

test("wiring: reconcileFeatured surfaces unmatched served rows as ghosts and selects them", () => {
  const candidates = buildProfileLists([
    group({ name: "Public", isCustomList: true, entries: [entry(2, media(31, 31))] }),
  ]);
  const served: FeaturedList[] = [
    { id: "s-secret", name: "Secret", items: [item("mal:9")] },
    { id: "s-public", name: "Public", items: [item("mal:31")] },
    { id: "s-local", name: "Local faves", items: [item("tt1000001")] },
  ];
  const { ghosts, selected } = reconcileFeatured(served, candidates);
  assert.deepEqual(
    ghosts.map((g) => g.id),
    ["srv:s-secret", "srv:s-local"],
    "the formerly featured rows stay visible with their removal affordance",
  );
  assert.deepEqual(selected, ["srv:s-secret", "anilist:custom:public", "srv:s-local"]);
});

test("over-limit served ghosts stay visible while Save is blocked until removal", () => {
  const served: FeaturedList[] = Array.from({ length: 8 }, (_, i) => ({
    id: `s${i}`,
    name: `Former list ${i}`,
    items: [item(`tt${i}`)],
  }));
  const { ghosts, selected } = reconcileFeatured(served, []);
  assert.equal(ghosts.length, 8, "none of the old public rows may disappear silently");
  assert.equal(selected.length, 8);
  assert.equal(
    isSaveReady(
      { handle: "alice", anilistUserId: null },
      "alice",
      null,
      false,
      selected.length > 6,
    ),
    false,
  );
});

test("no-adoption: a legacy AniList record is never absorbed by a same-name local list", () => {
  const localFaves: PickableList = {
    id: "local-1",
    name: "Faves",
    items: [item("tt1")],
    source: "local",
  };
  const localKnown: PickableList = {
    id: "local-2",
    name: "Known",
    items: [item("tt2")],
    source: "local",
  };
  const localTagged: PickableList = {
    id: "local-3",
    name: "Tagged",
    items: [item("tt9")],
    source: "local",
  };
  const served: FeaturedList[] = [
    // legacy AniList record (source stripped by the backend): AniList items
    { id: "s1", name: "Faves", items: [item("mal:50")] },
    // clean items but a remembered AniList list name (renamed/deleted list),
    // with a same-name local list present to tempt name matching
    { id: "s2", name: "Known", items: [item("tt2")] },
    // echoed AniList provenance with non-tracker item ids, same-name local list
    { id: "s3", name: "Tagged", items: [item("tt9")], source: "anilist" },
  ];
  const names = ["Known", "Faves"];
  const locals = [localFaves, localKnown, localTagged];

  // No AniList record may be name-matched onto a same-name local list...
  assert.deepEqual(matchSelection(served, locals, names), []);
  // ...all surface as blocking ghosts instead of silently vanishing into it.
  const ghosts = buildGhosts(served, locals, names);
  assert.deepEqual(
    ghosts.map((g) => g.id),
    ["srv:s1", "srv:s2", "srv:s3"],
  );
  const privacy: FeaturedPrivacy = {
    anilistNames: names,
    anilistVerified: true,
    anilistConnected: true,
  };
  for (const g of ghosts) {
    assert.equal(isPublishable(g, privacy), false);
    assert.equal(hasUnprovenSelection([g], [g.id], privacy), true);
  }
  // Even after explicitly removing the ghosts, featuring those local lists
  // must NOT reuse the formerly AniList-owned server ids at Save time.
  assert.deepEqual(
    buildFeaturedPayload(locals, served, locals, names).map((record) => record.id),
    ["", "", ""],
  );

  // A fresh verified AniList candidate of the same name is still a legal match.
  const anilistFaves: PickableList = {
    id: "anilist:0:faves",
    name: "Faves",
    items: [item("mal:50")],
    source: "anilist",
  };
  assert.deepEqual(matchSelection(served, [...locals, anilistFaves], names), ["anilist:0:faves"]);
  assert.deepEqual(
    buildGhosts(served, [...locals, anilistFaves], names).map((g) => g.id),
    ["srv:s2", "srv:s3"],
  );
});

test("failure: an AniList request failure serves the cache flagged unverified and never republishes it", async () => {
  resetForProfile();
  resetProfileLists();
  const cached = buildProfileLists([
    group({ name: "Faves", isCustomList: true, entries: [entry(1, media(50))] }),
  ]);
  writeCachedProfileLists(77, cached, ["Faves", "Secret"]);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new Error("network down"))) as typeof fetch;
  try {
    const res = await fetchProfileLists(77);
    assert.equal(res.verified, false, "cache fallback must never read as verified");
    assert.deepEqual(res.lists, cached);
    assert.deepEqual(res.names, ["Faves", "Secret"], "restricted names survive in the cache");

    const privacy: FeaturedPrivacy = {
      anilistNames: res.names,
      anilistVerified: false,
      anilistConnected: true,
    };
    // Unverified AniList candidates are never publishable...
    assert.equal(isPublishable(res.lists[0], privacy), false);
    // ...and a previously served AniList-backed row cannot ride on the cache either.
    const ghost: PickableList = { id: "srv:s1", name: "Faves", items: [item("mal:50")] };
    assert.equal(isPublishable(ghost, privacy), false);
    // The picker leaves loadedFor undefined on a failed connected fetch;
    // even a stale completed load cannot authorize publishing cached rows.
    const loaded = { handle: "alice", anilistUserId: 77 };
    assert.equal(isSaveReady(undefined, "alice", 77, false, false), false, "load pending");
    assert.equal(isSaveReady(loaded, "alice", 77, false, false), false, "unverified fetch");
    assert.equal(isSaveReady(loaded, "alice", 123, true, false), false, "other AniList account");
  } finally {
    globalThis.fetch = originalFetch;
    resetForProfile();
    resetProfileLists();
  }
});

test("success: a fresh fetch verifies candidates, surfaces every list name, and remembers names after deletion", async () => {
  resetForProfile();
  resetProfileLists();
  const response = (lists: unknown[]) =>
    new Response(JSON.stringify({ data: { MediaListCollection: { lists } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const publicGroup = (name: string, id: number) => ({
    status: null,
    name,
    isCustomList: true,
    entries: [entry(id, media(id))],
  });

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      response([
        publicGroup("Alpha", 10),
        { status: null, name: "Beta", isCustomList: true, entries: [entry(11, media(11), true)] },
      ])) as unknown as typeof fetch;
    const first = await fetchProfileLists(88);
    assert.equal(first.verified, true);
    assert.deepEqual(
      first.lists.map((l) => l.name),
      ["Alpha"],
    );
    assert.ok(first.lists.every((l) => l.source === "anilist"));
    // all-private group's name is surfaced (and cached) even though it has no list
    assert.deepEqual(first.names, ["Alpha", "Beta"]);

    // Beta's group disappears entirely (deleted on AniList): the remembered
    // name must keep its formerly served rows recognizable as AniList-owned.
    globalThis.fetch = (async () =>
      response([publicGroup("Alpha", 10)])) as unknown as typeof fetch;
    const second = await fetchProfileLists(88);
    assert.equal(second.verified, true);
    assert.deepEqual(second.names, ["Alpha", "Beta"]);
    assert.deepEqual(readCachedProfileListNames(88), ["Alpha", "Beta"]);
  } finally {
    globalThis.fetch = originalFetch;
    resetForProfile();
    resetProfileLists();
  }
});

test("ghost provenance: publishability requires positive local proof, never just a verified fetch", () => {
  const privacy: FeaturedPrivacy = { ...VERIFIED, anilistNames: ["Known"] };
  const ghostOf = (over: Partial<PickableList>): PickableList => ({
    id: "srv:s1",
    name: "Row",
    items: [item("tt1")],
    ...over,
  });

  // Persisted local provenance wins even for odd item ids.
  assert.equal(isPublishable(ghostOf({ source: "local", items: [item("mal:42")] }), privacy), true);
  // AniList provenance is never republished once it lacks a live candidate.
  assert.equal(isPublishable(ghostOf({ source: "anilist" }), privacy), false);
  // Legacy rows: clean Cinemeta-style items read as positively local.
  assert.equal(isPublishable(ghostOf({}), privacy), true);
  // Legacy AniList-style items are unproven even when the fetch verified —
  // a deleted/renamed AniList list leaves no trace in an unrelated response.
  assert.equal(isPublishable(ghostOf({ items: [item("mal:7")] }), privacy), false);
  assert.equal(isPublishable(ghostOf({ items: [item("anilist:7")] }), privacy), false);
  // A remembered AniList list name vetoes a legacy row regardless of items.
  assert.equal(isPublishable(ghostOf({ name: "Known" }), privacy), false);
  // Unverified and disconnected states keep the same item-signature verdicts.
  assert.equal(isPublishable(ghostOf({}), UNVERIFIED_PRIVACY), true);
  assert.equal(isPublishable(ghostOf({ items: [item("mal:7")] }), UNVERIFIED_PRIVACY), false);
});

test("save readiness: Harbor and AniList account switches never inherit the previous load", () => {
  const alice = { handle: "alice", anilistUserId: 7 };
  const disconnected = { handle: "alice", anilistUserId: null };
  assert.equal(isSaveReady(undefined, "alice", null, false, false), false);
  assert.equal(isSaveReady(undefined, "alice", 7, false, false), false);
  assert.equal(isSaveReady(disconnected, "alice", null, false, false), true);
  assert.equal(isSaveReady(disconnected, "alice", 7, true, false), false);
  assert.equal(isSaveReady(alice, "alice", 7, true, false), true);
  assert.equal(isSaveReady(alice, "alice", 7, false, false), false);
  assert.equal(isSaveReady(alice, "alice", 8, true, false), false);
  assert.equal(
    isSaveReady(alice, "bob", 7, true, false),
    false,
    "same AniList, other Harbor profile",
  );
  assert.equal(isSaveReady(alice, "alice", null, false, false), false);
  assert.equal(isSaveReady(alice, "alice", 7, true, true), false);
  assert.equal(isSaveReady(alice, null, 7, true, false), false);
});

test("payload: internal provenance never reaches the backend wire format", () => {
  const selected: PickableList[] = [
    { id: "local-1", name: "Mine", items: [item("tt1")], source: "local" },
    { id: "anilist:custom:faves", name: "Faves", items: [item("mal:2")], source: "anilist" },
  ];
  const internal = buildFeaturedPayload(selected, [], selected);
  assert.deepEqual(
    internal.map((row) => row.source),
    ["local", "anilist"],
  );
  const wire = featuredWirePayload(internal);
  for (const row of wire) {
    assert.equal("source" in row, false, "backend schema is outside this repo — never send it");
  }
  // A content-proven legacy local record keeps its historical server id.
  const served: FeaturedList[] = [{ id: "srv-9", name: "Mine", items: [item("tt1")] }];
  const withServed = buildFeaturedPayload([selected[0]], served, selected);
  assert.equal(withServed[0].id, "srv-9");
});

test("ghosts: every unmatched served row stays visible so removal is always explicit", () => {
  const served: FeaturedList[] = [
    { id: "s1", name: "Alpha", items: [item("tt1")] },
    { id: "s2", name: "Beta", items: [item("mal:2")] },
  ];
  const ghosts = buildGhosts(served, []);
  assert.deepEqual(
    ghosts.map((g) => g.id),
    ["srv:s1", "srv:s2"],
  );
  // matched candidates never ghost
  assert.deepEqual(
    buildGhosts(served, [{ id: "c1", name: "Alpha", source: "local", items: [item("tt1")] }]).map(
      (g) => ({ id: g.id, name: g.name, items: g.items, source: g.source }),
    ),
    [{ id: "srv:s2", name: "Beta", items: [item("mal:2")], source: undefined }],
  );
});
