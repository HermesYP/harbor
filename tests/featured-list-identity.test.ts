// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import {
  GHOST_ID_PREFIX,
  buildFeaturedPayload,
  keptFeaturedAfterUnfeature,
  resolveFeaturedClaims,
  toGhostList,
  type FeaturedList,
  type PickableList,
} from "../src/lib/social/list-identity.ts";

function items(prefix: string, count = 1) {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-item-${i}`,
    name: `${prefix} ${i}`,
    poster: `https://img.test/${prefix}-${i}.jpg`,
    type: "series",
  }));
}

/** Tracker-style ids (shared vocabulary: AniList picks always use these). */
function malItems(prefix: string, count = 1) {
  return Array.from({ length: count }, (_, i) => ({
    id: `mal:${prefix}${i}`,
    name: `${prefix} ${i}`,
    poster: `https://img.test/mal-${prefix}-${i}.jpg`,
    type: "series",
  }));
}

function localList(id: string, name: string, listItems = items(id)): PickableList {
  return { id, name, source: "local", items: listItems };
}

function anilistList(id: string, name: string, listItems = malItems(id)): PickableList {
  return { id, name, source: "anilist", items: listItems };
}

function record(id: string, name: string, over: Partial<FeaturedList> = {}): FeaturedList {
  return { id, name, items: items(id), ...over };
}

test("collision: a provenanced record adopts only a same-source pick", () => {
  const served = [record("S1", "Watching", { source: "anilist" })];
  const picks = [localList("L1", "Watching"), anilistList("A1", "Watching")];
  const claims = resolveFeaturedClaims(served, picks);
  assert.equal(claims[0].pickId, "A1");
  // the local same-name list must never adopt the AniList record
  const payload = buildFeaturedPayload([picks[0]], served, picks);
  assert.equal(payload[0].id, "");
  assert.equal(payload[0].source, "local");
  assert.deepEqual(payload[0].items, picks[0].items);
});

test("regression: local Watching no longer shadows or overwrites AniList Watching", () => {
  const served = [record("S1", "Watching", { source: "anilist" })];
  const picks = [localList("L1", "Watching"), anilistList("A1", "Watching")];
  // default selection follows the claim: the AniList list, not the local one
  const selection = resolveFeaturedClaims(served, picks).map((c) => c.pickId ?? c.ghostId);
  assert.deepEqual(selection, ["A1"]);
  // saving both same-name lists keeps the server id with the AniList content
  const payload = buildFeaturedPayload([picks[0], picks[1]], served, picks);
  const reused = payload.find((p) => p.id === "S1");
  assert.ok(reused);
  assert.equal(reused.source, "anilist");
  assert.deepEqual(reused.items, picks[1].items);
  const fresh = payload.find((p) => p.id === "");
  assert.equal(fresh?.source, "local");
  assert.deepEqual(fresh?.items, picks[0].items);
  // no duplicate server id ever
  const ids = payload.map((p) => p.id).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length);
});

test("legacy: an unattributed same-name collision is preserved as a safe ghost", () => {
  const legacy = record("S1", "Watching");
  const picks = [localList("L1", "Watching"), anilistList("A1", "Watching")];
  const claims = resolveFeaturedClaims([legacy], picks);
  assert.equal(claims[0].pickId, null);
  assert.equal(claims[0].ghostId, GHOST_ID_PREFIX + "S1");
  // keeping the ghost round-trips the record verbatim: nothing overwritten
  const ghost = toGhostList(claims[0]);
  const kept = buildFeaturedPayload([ghost], [legacy], picks);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].id, "S1");
  assert.equal(kept[0].name, "Watching");
  assert.deepEqual(kept[0].items, legacy.items);
  // and even selecting one of the colliding picks cannot steal the record id
  const replaced = buildFeaturedPayload([picks[1]], [legacy], picks);
  assert.equal(replaced[0].id, "");
  assert.deepEqual(replaced[0].items, picks[1].items);
});

test("legacy: one same-name source with matching content keeps the historical binding", () => {
  const served = [
    record("S1", "One", { source: "local", items: items("L1") }),
    record("S2", "Watching", { items: malItems("A1") }), // snapshot of the AniList list
    record("S3", "Watching", { items: malItems("A1") }),
  ];
  const picks = [localList("L1", "One"), anilistList("A1", "Watching")];
  const claims = resolveFeaturedClaims(served, picks);
  assert.equal(claims[0].pickId, "L1");
  // S2's content proves it came from the one same-name pick; S3 cannot double-adopt
  assert.equal(claims[1].pickId, "A1");
  assert.equal(claims[2].pickId, null);
  const payload = buildFeaturedPayload([picks[1], toGhostList(claims[2])], served, picks);
  assert.deepEqual(payload.map((p) => p.id), ["S2", "S3"]);
});

test("collision: same-source same-name twins bind only the content-proven one", () => {
  // e.g. an AniList status "Watching" and a custom list named "Watching"
  const statusTwin = anilistList("anilist:status:CURRENT", "Watching", malItems("s"));
  const customTwin = anilistList("anilist:custom:watching", "Watching", malItems("c"));
  const twins = [statusTwin, customTwin];
  // record content matches the custom list only: bind that one, not the first
  const served = [record("S1", "Watching", { source: "anilist", items: malItems("c") })];
  assert.equal(resolveFeaturedClaims(served, twins)[0].pickId, "anilist:custom:watching");
  // content matching neither twin fails closed instead of reusing the id
  const unmatched = [record("S2", "Watching", { source: "anilist", items: malItems("z") })];
  assert.equal(resolveFeaturedClaims(unmatched, twins)[0].pickId, null);
  // two identical twins cannot be told apart at all -> ghost
  const clones = [
    anilistList("t1", "Watching", malItems("same")),
    anilistList("t2", "Watching", malItems("same")),
  ];
  const shared = [record("S3", "Watching", { source: "anilist", items: malItems("same") })];
  assert.equal(resolveFeaturedClaims(shared, clones)[0].pickId, null);
});

test("legacy: name alone never binds — unproven records stay ghosts", () => {
  // e.g. the owner renamed or deleted their AniList list; only a same-name
  // local list remains. Without content proof the record must not be adopted
  // (and republished) through the local list.
  const snapshot = record("S1", "Watching", { items: malItems("snap") });
  const picks = [localList("L1", "Watching")];
  const claims = resolveFeaturedClaims([snapshot], picks);
  assert.equal(claims[0].pickId, null);
  assert.equal(claims[0].ghostId, GHOST_ID_PREFIX + "S1");
  const payload = buildFeaturedPayload(picks, [snapshot], picks);
  assert.equal(payload[0].id, "");
});

test("legacy: full containment is required — one-item overlap is not proof", () => {
  const snapshot = record("S1", "Watching", { items: malItems("r", 2) }); // mal:r0, mal:r1
  // shares exactly one item with the record (the old 50% rule accepted this)
  const anilist = anilistList("A1", "Watching", [malItems("r")[0], malItems("x")[0]]);
  assert.equal(resolveFeaturedClaims([snapshot], [anilist])[0].pickId, null);
});

test("legacy: an empty record fails closed — never adopted, never deleted", () => {
  const empty = record("S1", "Watching", { items: [] });
  const local = localList("L1", "Watching");
  assert.equal(resolveFeaturedClaims([empty], [local])[0].pickId, null);
  assert.deepEqual(keptFeaturedAfterUnfeature([empty], "Watching", "local", local.items), [empty]);
});

test("legacy: tracker-id content never proves local origin, even when identical", () => {
  // a local list saved from a shared list holds the exact same MAL ids as the
  // formerly-AniList record: identical content must not prove local origin
  const twin = malItems("twin", 2);
  const snapshot = record("S1", "Watching", { items: twin });
  const local = localList("L1", "Watching", twin);
  assert.equal(resolveFeaturedClaims([snapshot], [local])[0].pickId, null);
  assert.deepEqual(keptFeaturedAfterUnfeature([snapshot], "Watching", "local", twin), [snapshot]);
});

test("legacy: local-exclusive content keeps the historical local binding", () => {
  const local = localList("L1", "Watching", [...items("L1", 2), ...items("extra")]);
  // non-tracker ids can only come from a local list: containment proves it
  const snapshot = record("S1", "Watching", { items: items("L1", 2) });
  assert.equal(resolveFeaturedClaims([snapshot], [local])[0].pickId, "L1");
  assert.deepEqual(keptFeaturedAfterUnfeature([snapshot], "Watching", "local", local.items), []);
});

test("save: an unselected same-name candidate keeps the legacy ambiguity", () => {
  // the record content would even match the local list, but the unselected
  // AniList candidate makes the origin ambiguous: the id must not be rebound
  // just because the competitor is not part of the selection
  const legacy = record("S1", "Watching", { items: items("L1") });
  const picks = [localList("L1", "Watching"), anilistList("A1", "Watching")];
  const payload = buildFeaturedPayload([picks[0]], [legacy], picks);
  assert.equal(payload[0].id, "");
  assert.deepEqual(payload[0].items, picks[0].items);
});

test("ordering: served order survives with ghost slots interleaved and on save", () => {
  const served = [
    record("S1", "One", { source: "local" }),
    record("S2", "Watching"), // legacy + cross-source pair below -> ghost
    record("S3", "Two", { source: "anilist" }),
  ];
  const picks = [
    localList("L1", "One"),
    localList("L2", "Watching"),
    anilistList("A2", "Watching"),
    anilistList("A3", "Two"),
  ];
  const selection = resolveFeaturedClaims(served, picks).map((c) => c.pickId ?? c.ghostId);
  assert.deepEqual(selection, ["L1", GHOST_ID_PREFIX + "S2", "A3"]);
  const claims = resolveFeaturedClaims(served, picks);
  const byId = new Map<string, PickableList>([
    ...picks.map((p) => [p.id, p] as const),
    ...claims.filter((c) => c.pickId == null).map((c) => [c.ghostId, toGhostList(c)] as const),
  ]);
  const picked = selection.map((id) => byId.get(id) ?? assert.fail(`missing entry for ${id}`));
  const payload = buildFeaturedPayload(picked, served, picks);
  assert.deepEqual(payload.map((p) => p.id), ["S1", "S2", "S3"]);
  assert.deepEqual(payload[1].items, served[1].items);
});

test("save: the payload never carries duplicate server ids", () => {
  const served = [record("S1", "Watching", { source: "local" })];
  const dup = localList("L1", "Watching");
  const payload = buildFeaturedPayload([dup, dup], served, [dup]);
  assert.deepEqual(payload.map((p) => p.id), ["S1", ""]);
});

test("unfeature: scoped deletion fails closed on other sources and unattributed records", () => {
  const proof = items("L1");
  const served = [
    record("S1", "Watching", { source: "local" }),
    record("S2", "Watching", { source: "anilist" }),
    record("S3", "Watching", { items: items("L1") }), // non-tracker content proves local origin
    record("S4", "Watching", { items: malItems("A2") }), // AniList snapshot without provenance
    record("S5", "Other", { source: "anilist" }),
  ];
  const kept = keptFeaturedAfterUnfeature(served, "Watching", "local", proof);
  assert.deepEqual(kept.map((p) => p.id), ["S2", "S4", "S5"]);
  // without a source scope the historical name-scoped removal applies
  const unscoped = keptFeaturedAfterUnfeature(served, "Watching");
  assert.deepEqual(unscoped.map((p) => p.id), ["S5"]);
});

test("picker wiring: matching and saving share one claim map", () => {
  const src = readFileSync(new URL("../src/views/profile/my-lists-picker.tsx", import.meta.url), "utf8");
  assert.match(src, /resolveFeaturedClaims\(featured, lists\)/);
  assert.match(src, /resolveFeaturedClaims\(served, lists\)/);
  assert.match(src, /buildFeaturedPayload\(picked, served, lists\)/);
});
