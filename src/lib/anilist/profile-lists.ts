import type { FeaturedItem, PickableList } from "@/lib/social/featured-lists";
import { anilistMediaToMeta } from "./to-meta";
import type { AnilistMedia, MediaListStatus } from "./types";

/**
 * Fetches the owner's own AniList list groups (status lists and custom lists)
 * so they can be offered in the profile "My lists" picker. Runs only with the
 * connected owner's token; never queries another account.
 */
export const PROFILE_LISTS_QUERY = `query ($userId: Int) {
  MediaListCollection(userId: $userId, type: ANIME) {
    lists {
      status
      name
      isCustomList
      entries {
        id
        private
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

export type ProfileListGroup = {
  status: MediaListStatus | null;
  name: string | null;
  isCustomList: boolean;
  entries: Array<{
    id: number;
    private?: boolean;
    media: AnilistMedia;
  }>;
};

/** Mirrors MAX_FEATURED_ITEMS in lib/social/featured-lists (kept in sync by test). */
export const PROFILE_LIST_MAX_ITEMS = 24;

const STATUS_LIST_LABELS: Record<MediaListStatus, string> = {
  CURRENT: "Watching",
  PLANNING: "Plan to Watch",
  COMPLETED: "Completed",
  PAUSED: "On Hold",
  DROPPED: "Dropped",
  REPEATING: "Rewatching",
};

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "list"
  );
}

function groupName(group: ProfileListGroup): string {
  const named = (group.name ?? "").trim();
  if (named) return named;
  return group.status ? STATUS_LIST_LABELS[group.status] : "";
}

/**
 * Maps raw AniList list groups to pickable profile lists.
 * Private entries are dropped so featuring a list never publishes rows the
 * owner marked private on AniList, and each media appears at most once per list.
 *
 * Identity must survive collection reorders and status-list renames, so it
 * derives from AniList's own keys — the status for status lists, the name for
 * custom lists — never from the group's position in the response.
 */
export function buildProfileLists(groups: ProfileListGroup[]): PickableList[] {
  const built: Array<{ group: ProfileListGroup; name: string; items: FeaturedItem[] }> = [];
  groups.forEach((group) => {
    const name = groupName(group);
    if (!name) return;
    const items: FeaturedItem[] = [];
    const seenMedia = new Set<number>();
    for (const entry of group.entries ?? []) {
      if (entry.private === true) continue;
      if (!entry.media) continue;
      if (seenMedia.has(entry.media.id)) continue;
      seenMedia.add(entry.media.id);
      const meta = anilistMediaToMeta(entry.media);
      if (!meta) continue;
      items.push({
        id: meta.id,
        name: meta.name,
        poster: meta.poster ?? "",
        type: meta.type,
      });
      if (items.length >= PROFILE_LIST_MAX_ITEMS) break;
    }
    if (items.length === 0) return;
    built.push({ group, name, items });
  });
  // Custom lists are keyed by name; slug collisions (including duplicate
  // identical names) get a deterministic rank — sorted by name, input order
  // for exact ties — so neither reordering the response nor duplicate names
  // can change or collide with any list's id.
  const ranks = new Map<number, number>();
  const bySlug = new Map<string, number[]>();
  built.forEach(({ group, name }, index) => {
    if (isStatusList(group)) return;
    const key = slug(name);
    bySlug.set(key, [...(bySlug.get(key) ?? []), index]);
  });
  for (const indices of bySlug.values()) {
    if (indices.length === 1) continue;
    const ordered = [...indices].sort((a, b) => {
      const nameA = built[a].name;
      const nameB = built[b].name;
      return nameA < nameB ? -1 : nameA > nameB ? 1 : a - b;
    });
    ordered.forEach((builtIndex, rank) => ranks.set(builtIndex, rank + 1));
  }
  return built.map(({ group, name, items }, index) => {
    let id: string;
    if (isStatusList(group)) {
      id = `anilist:status:${group.status}`;
    } else {
      const key = slug(name);
      const rank = ranks.get(index);
      id = `anilist:custom:${key}` + (rank != null ? `:${rank}` : "");
    }
    return { id, source: "anilist", name, items };
  });
}

function isStatusList(group: ProfileListGroup): boolean {
  return !group.isCustomList && group.status != null;
}

const CACHE_PREFIX = "harbor.anilist.profilelists.v2.";
const memCache = new Map<number, PickableList[]>();

export function profileListsCacheKey(userId: number): string {
  return CACHE_PREFIX + userId;
}

export function readCachedProfileLists(userId: number): PickableList[] | null {
  const mem = memCache.get(userId);
  if (mem) return mem;
  try {
    const raw = localStorage.getItem(profileListsCacheKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { lists?: PickableList[] };
    if (!parsed || !Array.isArray(parsed.lists)) return null;
    memCache.set(userId, parsed.lists);
    return parsed.lists;
  } catch {
    return null;
  }
}

export function writeCachedProfileLists(userId: number, lists: PickableList[]): void {
  memCache.set(userId, lists);
  try {
    localStorage.setItem(profileListsCacheKey(userId), JSON.stringify({ at: Date.now(), lists }));
  } catch {
    /* storage failures keep the in-memory copy */
  }
}

export function resetProfileLists(): void {
  memCache.clear();
}
