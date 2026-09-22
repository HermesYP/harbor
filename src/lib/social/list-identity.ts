/**
 * Source-aware identity for featured lists.
 *
 * Local custom lists and AniList lists are separate namespaces: two lists may
 * legitimately share a name ("Watching") while holding different content, so a
 * name alone is not an identity. Every pickable list carries its provenance and
 * a server record is only ever re-associated with a pick from the same source.
 *
 * Records written before provenance existed — including any the backend drops
 * unknown fields for — have no source. Those are adopted only with
 * source-exclusive content proof and no same-name ambiguity; otherwise the
 * record is preserved verbatim as a ghost so nothing is silently overwritten.
 */

export type ListSource = "local" | "anilist";

export type FeaturedItem = {
  id: string;
  name: string;
  poster: string;
  type: string;
};

export type FeaturedList = {
  id: string;
  name: string;
  items: FeaturedItem[];
  coverImage?: string;
  bgImage?: string;
  bgMode?: string;
  likeCount?: number;
  liked?: boolean;
  /** Where the list came from. Optional: legacy server records predate it. */
  source?: ListSource;
};

export type PickableList = {
  id: string;
  name: string;
  items: FeaturedItem[];
  coverImage?: string;
  bgImage?: string;
  bgMode?: string;
  source?: ListSource;
};

/** Prefix marking picker entries that stand in for an unmatched server record. */
export const GHOST_ID_PREFIX = "srv:";

export type FeaturedClaim = {
  /** The server record being resolved. */
  served: FeaturedList;
  /** Pickable list that adopts the record, or null when it stays a ghost. */
  pickId: string | null;
  /** Stable picker id for the ghost entry (unused while a pick claims the record). */
  ghostId: string;
};

export function normalizeListName(name: string): string {
  return name.replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
}

/**
 * Tracker-style media ids are shared vocabulary: AniList picks always use them
 * (mal:/anilist:), but local lists can hold the very same ids via saved shared
 * lists. Non-tracker ids (tt…, tmdb:…) can only come from a local list.
 */
const TRACKER_ITEM_ID = /^(kitsu|mal|anilist|anidb):/i;

/**
 * Conservative, source-exclusive origin proof for unattributed records.
 *
 * Overlap alone is never proof: the record must be nonempty and FULLY
 * contained in the candidate list, and the signature must exclude the other
 * source. Tracker-id content can never prove local origin (a local list may
 * contain the same MAL/AniList titles), so only an AniList-sourced pick may
 * adopt it; non-tracker content is impossible for an AniList pick, so it
 * exclusively proves local origin. Anything else fails closed.
 */
function contentProvesOrigin(
  record: FeaturedList,
  items: Array<{ id: string }>,
  source: ListSource | undefined,
): boolean {
  if (source == null) return false;
  if (record.items.length === 0) return false;
  const ids = new Set(items.map((item) => item.id));
  if (!record.items.every((item) => ids.has(item.id))) return false;
  const trackerDerived = record.items.every((item) => TRACKER_ITEM_ID.test(item.id));
  return trackerDerived ? source === "anilist" : source === "local";
}

/**
 * Resolves each served record to at most one pickable list, in served order.
 *
 * - A record with provenance only matches picks from that source (the source
 *   field is independent provenance and needs no content proof for a sole
 *   candidate). Same-name twins within one source are only told apart by
 *   content proof, and only when that singles one candidate out.
 * - A record without provenance matches by name only when its content proves
 *   the source; known AniList names also veto local adoption, even when the
 *   old server record has a non-tracker id. Anything weaker stays a ghost
 *   instead of being silently adopted by a same-name list.
 * - Each pick and each server id is claimed at most once; unmatched records
 *   stay ghosts that keep their content and identity.
 */
export function resolveFeaturedClaims(
  served: FeaturedList[],
  picks: PickableList[],
  knownAnilistNames: string[] = [],
): FeaturedClaim[] {
  const known = new Set(knownAnilistNames.map(normalizeListName));
  const claimed = new Set<string>();
  return served.map((record, index) => {
    const ghostId = GHOST_ID_PREFIX + (record.id || `#${index}`);
    const key = normalizeListName(record.name);
    let candidates = picks.filter((p) => !claimed.has(p.id) && normalizeListName(p.name) === key);
    if (record.source) {
      candidates = candidates.filter((p) => p.source === record.source);
    } else if (known.has(key)) {
      // A legacy row bearing a remembered AniList name may have been deleted,
      // renamed, or rewritten by the server. Never let a same-name local list
      // adopt it; a live AniList candidate still needs full content proof.
      candidates = candidates.filter(
        (p) => p.source === "anilist" && contentProvesOrigin(record, p.items, p.source),
      );
    } else {
      const sources = new Set(candidates.map((p) => p.source ?? "unknown"));
      if (sources.size > 1) {
        candidates = [];
      } else {
        candidates = candidates.filter((p) => contentProvesOrigin(record, p.items, p.source));
      }
    }
    // Same-name twins (e.g. an AniList status "Watching" and a custom
    // "Watching", or two local lists) can only be told apart by content; if
    // proof does not single one out, fail closed to a ghost.
    if (candidates.length > 1) {
      candidates = candidates.filter((p) => contentProvesOrigin(record, p.items, p.source));
    }
    if (candidates.length !== 1) return { served: record, pickId: null, ghostId };
    const pick = candidates[0];
    claimed.add(pick.id);
    return { served: record, pickId: pick.id, ghostId };
  });
}

/** Materializes the picker entry for a ghost claim, preserving record content. */
export function toGhostList(claim: FeaturedClaim): PickableList {
  const record = claim.served;
  return {
    id: claim.ghostId,
    name: record.name,
    source: record.source,
    coverImage: record.coverImage,
    bgImage: record.bgImage,
    bgMode: record.bgMode,
    items: record.items,
  };
}

/**
 * Builds the featured payload for the given selection order.
 *
 * `allPicks` must be the full candidate universe claims are resolved against —
 * every local and AniList list (never ghost entries, never just the selection):
 * a same-name candidate that is not selected still counts for ambiguity, so a
 * legacy record cannot be rebound to the wrong source just because its
 * competitor was left unselected. A server id is only ever reused by the pick
 * that legitimately claimed it, and never appears twice in one payload.
 */
export function buildFeaturedPayload(
  selected: PickableList[],
  served: FeaturedList[],
  allPicks: PickableList[],
  knownAnilistNames: string[] = [],
): FeaturedList[] {
  const claims = resolveFeaturedClaims(served, allPicks, knownAnilistNames);
  const recordByGhostId = new Map<string, FeaturedList>();
  const servedIdByPickId = new Map<string, string>();
  for (const claim of claims) {
    if (claim.pickId) {
      if (claim.served.id) servedIdByPickId.set(claim.pickId, claim.served.id);
    } else {
      recordByGhostId.set(claim.ghostId, claim.served);
    }
  }
  const usedIds = new Set<string>();
  const takeId = (id: string): string => {
    if (!id || usedIds.has(id)) return "";
    usedIds.add(id);
    return id;
  };
  return selected.map((list) => {
    const ghostRecord = recordByGhostId.get(list.id);
    if (ghostRecord) {
      // Ghosts round-trip their record verbatim so its content, art, and
      // provenance survive a save that does not touch it.
      return {
        id: takeId(ghostRecord.id),
        name: ghostRecord.name,
        source: ghostRecord.source,
        coverImage: ghostRecord.coverImage,
        bgImage: ghostRecord.bgImage,
        bgMode: ghostRecord.bgMode,
        items: ghostRecord.items,
      };
    }
    return {
      id: takeId(servedIdByPickId.get(list.id) ?? ""),
      name: list.name,
      source: list.source,
      coverImage: list.coverImage,
      bgImage: list.bgImage,
      bgMode: list.bgMode,
      items: list.items,
    };
  });
}

/**
 * Filters the served records down to what survives unfeaturing `name` from one
 * source. A record proven to belong to another source is never removed (deleting
 * the local "Watching" must not unfeature the AniList "Watching"), and for a
 * source-scoped unfeature an unattributed legacy record is only removed when
 * `proofItems` source-exclusively prove it was saved from this very list —
 * anything unknown fails closed and stays featured. Without a source the
 * historical name-scoped removal applies.
 */
export function keptFeaturedAfterUnfeature(
  served: FeaturedList[],
  name: string,
  source?: ListSource,
  proofItems: Array<{ id: string }> = [],
): FeaturedList[] {
  const target = normalizeListName(name);
  return served.filter((record) => {
    if (normalizeListName(record.name) !== target) return true;
    if (source == null) return false;
    if (record.source != null) return record.source !== source;
    return !contentProvesOrigin(record, proofItems, source);
  });
}
