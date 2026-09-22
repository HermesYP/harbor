import { AnilistApiError, anilistRequest } from "./client";
import {
  PROFILE_LISTS_QUERY,
  buildProfileLists,
  profileListGroupNames,
  readCachedProfileListNames,
  readCachedProfileLists,
  resetProfileLists,
  writeCachedProfileLists,
  type ProfileListGroup,
} from "./profile-lists";
import type { AnilistListGroup, AnilistMediaEntry, MediaListStatus } from "./types";
import { validateAnilistSession } from "./validate";
import type { PickableList } from "@/lib/social/featured-lists";

const COLLECTION_QUERY = `query ($userId: Int) {
  MediaListCollection(userId: $userId, type: ANIME) {
    lists {
      status
      isCustomList
      entries {
        id
        status
        progress
        score
        media {
          id
          idMal
          title { romaji english native userPreferred }
          coverImage { extraLarge large medium }
          bannerImage
          format
          episodes
          averageScore
          seasonYear
        }
      }
    }
  }
}`;

type RawGroup = {
  status: MediaListStatus | null;
  isCustomList: boolean;
  entries: AnilistMediaEntry[];
};

type CollectionResponse = { MediaListCollection: { lists: RawGroup[] } | null };

const CACHE_PREFIX = "harbor.anilist.collection.v1.";
const memCache = new Map<number, AnilistListGroup[]>();
const inflight = new Map<number, Promise<AnilistListGroup[]>>();

export function resetForProfile() {
  memCache.clear();
  inflight.clear();
  resetProfileLists();
  profileListsInflight.clear();
}

function cacheKey(userId: number): string {
  return CACHE_PREFIX + userId;
}

export function readCachedCollection(userId: number): AnilistListGroup[] | null {
  const mem = memCache.get(userId);
  if (mem) return mem;
  try {
    const raw = localStorage.getItem(cacheKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { groups?: AnilistListGroup[] };
    if (!parsed || !Array.isArray(parsed.groups)) return null;
    memCache.set(userId, parsed.groups);
    return parsed.groups;
  } catch {
    return null;
  }
}

function writeCachedCollection(userId: number, groups: AnilistListGroup[]): void {
  memCache.set(userId, groups);
  try {
    localStorage.setItem(cacheKey(userId), JSON.stringify({ at: Date.now(), groups }));
  } catch {}
}

function buildGroups(lists: RawGroup[]): AnilistListGroup[] {
  const byStatus = new Map<MediaListStatus, AnilistMediaEntry[]>();
  const seen = new Set<number>();
  for (const group of lists) {
    if (group.isCustomList || !group.status) continue;
    const bucket = byStatus.get(group.status) ?? [];
    for (const entry of group.entries) {
      if (seen.has(entry.media.id)) continue;
      seen.add(entry.media.id);
      bucket.push(entry);
    }
    byStatus.set(group.status, bucket);
  }
  return Array.from(byStatus.entries()).map(([status, entries]) => ({ status, entries }));
}

export async function fetchMediaListCollection(userId: number): Promise<AnilistListGroup[]> {
  const existing = inflight.get(userId);
  if (existing) return existing;
  const run = (async () => {
    const data = await anilistRequest<CollectionResponse>(COLLECTION_QUERY, { userId }).catch(
      (e) => {
        if (e instanceof AnilistApiError && e.status === 401) void validateAnilistSession();
        return null;
      },
    );
    if (data == null) {
      const cached = readCachedCollection(userId);
      return cached ?? [];
    }
    const groups = buildGroups(data.MediaListCollection?.lists ?? []);
    writeCachedCollection(userId, groups);
    return groups;
  })();
  inflight.set(userId, run);
  try {
    return await run;
  } finally {
    inflight.delete(userId);
  }
}

type ProfileListsResponse = { MediaListCollection: { lists: ProfileListGroup[] } | null };

const profileListsInflight = new Map<number, Promise<ProfileListsResult>>();

/**
 * Result of loading the owner's AniList lists as featured-list candidates.
 * `verified` is true only for a fresh, successful AniList response: cache
 * fallback is served with `verified: false` so callers can display it but
 * never republish its items, whose current AniList privacy is unknown.
 */
export type ProfileListsResult = {
  lists: PickableList[];
  /** Display names of every known AniList list, including all-private ones. */
  names: string[];
  verified: boolean;
};

/**
 * Loads the connected owner's AniList lists as profile-featured candidates.
 * Falls back to the per-user cache when AniList is unreachable, flagged
 * `verified: false`; never leaks across accounts because the cache and
 * inflight keys are per AniList userId.
 */
export async function fetchProfileLists(userId: number): Promise<ProfileListsResult> {
  const existing = profileListsInflight.get(userId);
  if (existing) return existing;
  const run = (async (): Promise<ProfileListsResult> => {
    const data = await anilistRequest<ProfileListsResponse>(PROFILE_LISTS_QUERY, { userId }).catch(
      (e) => {
        if (e instanceof AnilistApiError && e.status === 401) void validateAnilistSession();
        return null;
      },
    );
    if (data == null) {
      return {
        lists: readCachedProfileLists(userId) ?? [],
        names: readCachedProfileListNames(userId) ?? [],
        verified: false,
      };
    }
    const groups = data.MediaListCollection?.lists ?? [];
    const lists = buildProfileLists(groups);
    // Remember names beyond the current response: a deleted or renamed AniList
    // list vanishes from the fetch, and its formerly served rows must stay
    // recognizable as AniList-owned for privacy reconciliation.
    const names = [
      ...new Set([...profileListGroupNames(groups), ...(readCachedProfileListNames(userId) ?? [])]),
    ];
    writeCachedProfileLists(userId, lists, names);
    return { lists, names, verified: true };
  })();
  profileListsInflight.set(userId, run);
  try {
    return await run;
  } finally {
    profileListsInflight.delete(userId);
  }
}
