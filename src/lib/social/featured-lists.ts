import { safeFetch } from "@/lib/safe-fetch";
import { authToken, currentAuthor } from "@/lib/theme-auth";
import { readLists, type CustomList } from "@/lib/custom-lists";
import { bakeDefaultPosters } from "./featured-posters";
import { HARBOR_API_BASE } from "@/lib/config/endpoints";
import {
  keptFeaturedAfterUnfeature,
  normalizeListName,
  type ListSource,
} from "./list-identity";

export { likeList, unlikeList } from "./list-likes";
export type { ListLike } from "./list-likes";
export {
  GHOST_ID_PREFIX,
  buildFeaturedPayload,
  keptFeaturedAfterUnfeature,
  normalizeListName,
  resolveFeaturedClaims,
  toGhostList,
} from "./list-identity";
export type {
  FeaturedClaim,
  FeaturedItem,
  FeaturedList,
  ListSource,
  PickableList,
} from "./list-identity";
import type { FeaturedList, PickableList } from "./list-identity";

const BASE = `${HARBOR_API_BASE}/themes/api/social`;

export const MAX_FEATURED_LISTS = 6;
export const MAX_FEATURED_ITEMS = 24;

export function toPickableList(list: CustomList): PickableList {
  return {
    id: list.id,
    name: list.name,
    source: "local",
    coverImage: list.coverImage,
    bgImage: list.bgImage,
    bgMode: list.bgMode,
    items: list.items.slice(0, MAX_FEATURED_ITEMS).map((it) => ({
      id: it.id,
      name: it.name,
      poster: it.poster ?? "",
      type: it.type,
    })),
  };
}

export function readLocalLists(): PickableList[] {
  return readLists().map(toPickableList);
}

export function toFeaturedList(list: PickableList): FeaturedList {
  return {
    id: "",
    name: list.name,
    source: list.source,
    items: list.items,
    coverImage: list.coverImage,
    bgImage: list.bgImage,
    bgMode: list.bgMode,
  };
}

function authHeaders(): Record<string, string> {
  const t = authToken();
  return t ? { authorization: `Bearer ${t}` } : {};
}

function readFeatured(data: unknown): FeaturedList[] {
  const lists = (data as { featuredLists?: unknown } | null)?.featuredLists;
  return Array.isArray(lists) ? (lists as FeaturedList[]) : [];
}

export async function fetchFeaturedLists(
  handle: string,
  signal?: AbortSignal,
): Promise<FeaturedList[]> {
  const res = await safeFetch(`${BASE}/u/${encodeURIComponent(handle)}`, {
    headers: authHeaders(),
    signal,
  });
  if (!res.ok) throw new Error(`featured lists ${res.status}`);
  return readFeatured(await res.json());
}

export async function fetchSharedList(
  handle: string,
  listId: string,
  signal?: AbortSignal,
): Promise<FeaturedList | null> {
  const lists = await fetchFeaturedLists(handle, signal);
  return lists.find((l) => l.id === listId) ?? null;
}

// The backend schema lives outside this repository and may reject unknown
// fields. Keep provenance for client-side identity/privacy checks, but do not
// rely on it round-tripping through the featured-lists PATCH response.
export function featuredWirePayload(lists: FeaturedList[]): Array<Omit<FeaturedList, "source">> {
  return lists.map(({ source: _source, ...record }) => record);
}

export async function saveFeaturedLists(
  lists: FeaturedList[],
  clear = false,
  expectedHandle?: string,
): Promise<FeaturedList[]> {
  const baked = lists.length > 0 ? await bakeDefaultPosters(lists) : lists;
  // Poster baking is async: do not PATCH another Harbor profile if it changed
  // while this save was in flight.
  if (expectedHandle && currentAuthor()?.handle !== expectedHandle) {
    throw new Error("featured-list owner changed during save");
  }
  const body: Record<string, unknown> = { featuredLists: featuredWirePayload(baked) };
  if (clear) body.clearFeaturedLists = true;
  const res = await safeFetch(`${BASE}/me/profile`, {
    method: "PATCH",
    headers: { ...authHeaders(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`save featured lists ${res.status}`);
  const echoed = readFeatured(await res.json());
  return echoed.length || lists.length === 0 ? echoed : lists;
}

export async function unfeatureListByName(
  name: string,
  source?: ListSource,
  proofItems: Array<{ id: string }> = [],
): Promise<void> {
  const handle = currentAuthor()?.handle;
  const target = normalizeListName(name);
  if (!handle || !target) return;
  const served = await fetchFeaturedLists(handle);
  const kept = keptFeaturedAfterUnfeature(served, name, source, proofItems);
  if (kept.length !== served.length) await saveFeaturedLists(kept, true, handle);
}

export function listShareUrl(handle: string, listId: string): string {
  return `${HARBOR_API_BASE}/list/${encodeURIComponent(handle)}/${encodeURIComponent(listId)}`;
}

export function listDeepLink(handle: string, listId: string): string {
  return `harbor://list/${encodeURIComponent(handle)}/${encodeURIComponent(listId)}`;
}
