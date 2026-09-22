import {
  normalizeListName,
  resolveFeaturedClaims,
  toGhostList,
  type FeaturedList,
  type PickableList,
} from "./list-identity";

/**
 * Privacy policy for source-aware featured-list reconciliation. The picker
 * passes only freshly verified AniList candidates to the shared identity
 * resolver; unmatched served rows remain visible as blocking ghosts until
 * the owner explicitly removes them.
 */

export type FeaturedPrivacy = {
  /**
   * Display names ever seen for the owner's AniList lists — fresh on a
   * verified fetch, remembered names from the per-user cache otherwise.
   * Includes lists that publish no items (all entries private), so a served
   * entry with such a name is recognized as AniList-owned even when its
   * persisted source did not round-trip.
   */
  anilistNames: string[];
  /** True only for a fresh successful AniList response. */
  anilistVerified: boolean;
  /** Whether the owner has AniList connected at all. */
  anilistConnected: boolean;
};

/** Pre-settle / disconnected default: nothing AniList-sourced is verified. */
export const UNVERIFIED_PRIVACY: FeaturedPrivacy = {
  anilistNames: [],
  anilistVerified: false,
  anilistConnected: false,
};

/** Candidate ids minted by buildProfileLists. */
function isAnilistCandidate(entry: PickableList): boolean {
  // The id check covers caches written before sources were persisted.
  return entry.source === "anilist" || entry.id.startsWith("anilist:");
}

/**
 * Every AniList mapping (see anilistMediaToMeta) produces `mal:` or
 * `anilist:` item ids, while library/custom-list rows come from the
 * Cinemeta/TMDB pipelines. A legacy ghost whose items carry these prefixes
 * therefore cannot be positively identified as local.
 */
function itemsLookAnilist(items: PickableList["items"]): boolean {
  return items.some((item) => item.id.startsWith("mal:") || item.id.startsWith("anilist:"));
}

/**
 * Whether a selected entry may enter the featured payload. Local lists are
 * always publishable; AniList candidates require a verified fetch; served
 * ghosts require positive local proof — persisted `local` provenance, or for
 * legacy payloads a sound item signature (never `mal:`/`anilist:` ids) that
 * is not contradicted by a remembered AniList list name.
 */
export function isPublishable(entry: PickableList, privacy: FeaturedPrivacy): boolean {
  if (entry.id.startsWith("srv:")) {
    if (entry.source === "local") return true;
    if (entry.source === "anilist") return false;
    // Legacy payload without a source: fail closed unless positively
    // identified as local. AniList list names may be stale or incomplete
    // (deleted/renamed lists leave no trace in a fresh fetch), so a verified
    // fetch alone proves nothing about an orphaned row — only clean items
    // (the AniList mapping always emits mal:/anilist: ids) clear it, and a
    // remembered AniList name vetoes it as a belt against mapping changes.
    if (itemsLookAnilist(entry.items)) return false;
    const known = new Set(privacy.anilistNames.map(normalizeListName));
    return !known.has(normalizeListName(entry.name));
  }
  if (isAnilistCandidate(entry)) return privacy.anilistVerified;
  return true;
}

/** Matches only identity-proven served records; names are never identity. */
export function matchSelection(
  featured: FeaturedList[],
  lists: PickableList[],
  anilistNames: string[] = [],
): string[] {
  return resolveFeaturedClaims(featured, lists, anilistNames)
    .map((claim) => claim.pickId)
    .filter((id): id is string => id != null);
}

/** Unclaimed served records remain visible with an explicit removal control. */
export function buildGhosts(
  served: FeaturedList[],
  candidates: PickableList[],
  anilistNames: string[] = [],
): PickableList[] {
  return resolveFeaturedClaims(served, candidates, anilistNames)
    .filter((claim) => claim.pickId == null)
    .map(toGhostList);
}

export type ReconciledFeatured = {
  ghosts: PickableList[];
  /** Original served order, including ghosts in their existing slots. */
  selected: string[];
};

export function reconcileFeatured(
  served: FeaturedList[],
  candidates: PickableList[],
  anilistNames: string[] = [],
): ReconciledFeatured {
  const claims = resolveFeaturedClaims(served, candidates, anilistNames);
  return {
    ghosts: claims.filter((claim) => claim.pickId == null).map(toGhostList),
    // Never hide an existing served record to enforce the selection limit:
    // Save is disabled until the owner removes excess rows explicitly.
    selected: claims.map((claim) => claim.pickId ?? claim.ghostId),
  };
}

/**
 * Resolves a selection to the ordered lists that may be uploaded. Only ever
 * called once hasUnprovenSelection() is false, so nothing selected is
 * dropped silently; kept as the last line of defense for the privacy
 * invariant (never republish unverified AniList items).
 */
export function publishableSelection(
  entries: PickableList[],
  selected: string[],
  privacy: FeaturedPrivacy,
): PickableList[] {
  const byId = new Map(entries.map((e) => [e.id, e] as const));
  const out: PickableList[] = [];
  for (const id of selected) {
    const entry = byId.get(id);
    if (entry && isPublishable(entry, privacy)) out.push(entry);
  }
  return out;
}

/**
 * True when the current selection contains a displayed row whose items may
 * not be republished. The picker disables Save in that case and relies on the
 * existing per-row remove button as the explicit way out — the alternative,
 * filtering such rows at save time, would silently delete them from the
 * public profile.
 */
export function hasUnprovenSelection(
  entries: PickableList[],
  selected: string[],
  privacy: FeaturedPrivacy,
): boolean {
  const byId = new Map(entries.map((e) => [e.id, e] as const));
  for (const id of selected) {
    const entry = byId.get(id);
    if (entry && !isPublishable(entry, privacy)) return true;
  }
  return false;
}

export type LoadedFeaturedFor = { handle: string; anilistUserId: number | null };

/**
 * Save readiness follows BOTH the Harbor profile and the connected AniList
 * account. An account switch invalidates the previous load immediately, even
 * before the effect cleanup/reset runs; a failed verification never authorizes
 * publishing another profile's previously served rows.
 */
export function isSaveReady(
  loadedFor: LoadedFeaturedFor | undefined,
  activeHandle: string | null,
  activeUserId: number | null,
  anilistVerified: boolean,
  hasUnproven: boolean,
): boolean {
  if (!activeHandle || !loadedFor || loadedFor.handle !== activeHandle) return false;
  if (loadedFor.anilistUserId !== activeUserId) return false;
  if (activeUserId != null && !anilistVerified) return false;
  return !hasUnproven;
}
