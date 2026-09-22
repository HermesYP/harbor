/**
 * Source-aware identity for featured lists.
 *
 * Local custom lists and AniList lists are separate namespaces: two lists may
 * legitimately share a name ("Watching") while holding different content, so a
 * name alone is not an identity. Every pickable list carries its provenance and
 * a server record is only ever re-associated with a pick from the same source.
 *
 * Records written before provenance existed — including any the backend drops
 * unknown fields for — have no source. Those are adopted by name only when
 * exactly one source offers that name; otherwise the record is preserved
 * verbatim as a ghost so nothing is silently overwritten.
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
 * Content signature used as positive proof of origin for unattributed records:
 * the record was once saved from some list, so most of its items must still be
 * present in that list. Same-name alone is never proof — a renamed or deleted
 * AniList list must not get republished through a same-name local list.
 */
function contentProvesOrigin(record: FeaturedList, items: Array<{ id: string }>): boolean {
  const ids = new Set(items.map((item) => item.id));
  const recordIds = record.items.map((item) => item.id);
  if (recordIds.length === 0) return true;
  const matched = recordIds.filter((id) => ids.has(id)).length;
  return matched * 2 >= recordIds.length;
}

/**
 * Resolves each served record to at most one pickable list, in served order.
 *
 * - A record with provenance only matches picks from that source.
 * - A record without provenance matches by name only when a single source
 *   offers that name AND that pick's content still proves it produced the
 *   record; anything weaker leaves the record a ghost instead of letting it be
 *   silently adopted (and later overwritten) by a same-name list.
 * - Each pick and each server id is claimed at most once; unmatched records
 *   stay ghosts that keep their content and identity.
 */
export function resolveFeaturedClaims(
  served: FeaturedList[],
  picks: PickableList[],
): FeaturedClaim[] {
  const claimed = new Set<string>();
  return served.map((record, index) => {
    const ghostId = GHOST_ID_PREFIX + (record.id || `#${index}`);
    const key = normalizeListName(record.name);
    let candidates = picks.filter((p) => !claimed.has(p.id) && normalizeListName(p.name) === key);
    if (record.source) {
      candidates = candidates.filter((p) => p.source === record.source);
    } else {
      const sources = new Set(candidates.map((p) => p.source ?? "unknown"));
      if (sources.size > 1) {
        candidates = [];
      } else {
        candidates = candidates.filter((p) => contentProvesOrigin(record, p.items));
      }
    }
    const pick = candidates[0];
    if (!pick) return { served: record, pickId: null, ghostId };
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
): FeaturedList[] {
  const claims = resolveFeaturedClaims(served, allPicks);
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
 * `proofItems` show it was saved from this very list — anything unknown fails
 * closed and stays featured. Without a source the historical name-scoped
 * removal applies.
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
    return !contentProvesOrigin(record, proofItems);
  });
}
