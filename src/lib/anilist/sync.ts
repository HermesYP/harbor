import { activeProfileId } from "@/lib/active-profile-id";
import { kitsuToAnilist } from "@/lib/providers/anime-mapping";
import { AnilistApiError, anilistRequest } from "./client";
import { createProgressSyncDeps, runAnimeProgressSync } from "./progress-sync";
import { getSession, isAuthenticated } from "./session";

export type SyncEvent =
  | { kind: "syncing"; title: string; episode: number }
  | { kind: "ok"; title: string; episode: number }
  | { kind: "watching"; title: string }
  | { kind: "error"; title: string; message: string };

const listeners = new Set<(e: SyncEvent) => void>();
let last: SyncEvent | null = null;

export function subscribeSync(fn: (e: SyncEvent) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getLastSync(): SyncEvent | null {
  return last;
}

function emit(e: SyncEvent): void {
  last = e;
  for (const fn of listeners) fn(e);
}

function leadingInt(value: string): number | null {
  const n = Number(value.split(":")[0]);
  return Number.isFinite(n) ? n : null;
}

const MAL_QUERY = `query ($idMal: Int) { Media(idMal: $idMal, type: ANIME) { id } }`;

async function malToAnilist(idMal: number): Promise<number | null> {
  try {
    const data = await anilistRequest<{ Media: { id: number } | null }>(MAL_QUERY, { idMal });
    return data?.Media?.id ?? null;
  } catch {
    return null;
  }
}

export async function resolveAnilistMediaId(harborId: string): Promise<number | null> {
  if (harborId.startsWith("anilist:")) return leadingInt(harborId.slice(8));
  if (harborId.startsWith("kitsu:")) {
    const k = leadingInt(harborId.slice(6));
    return k != null ? kitsuToAnilist(k) : null;
  }
  if (harborId.startsWith("mal:")) {
    const m = leadingInt(harborId.slice(4));
    return m != null ? malToAnilist(m) : null;
  }
  return null;
}

const WATCHING_ENTRY_QUERY = `query ($id: Int) {
  Media(id: $id, type: ANIME) {
    id
    episodes
    mediaListEntry { id progress status repeat }
  }
}`;

const SAVE_STATUS_MUTATION = `mutation ($mediaId: Int, $status: MediaListStatus) {
  SaveMediaListEntry(mediaId: $mediaId, status: $status) {
    id
    status
  }
}`;

type EntryResponse = {
  Media: {
    id: number;
    episodes: number | null;
    mediaListEntry: { id: number; progress: number; status: string; repeat: number } | null;
  } | null;
};

const watchingMarked = new Set<string>();
const progressQueue = new Map<number, Promise<void>>();

/** Serialize progress writes per media so a slower response cannot overwrite a newer one. */
function enqueueProgressSync(mediaId: number, run: () => Promise<void>): Promise<void> {
  const previous = progressQueue.get(mediaId) ?? Promise.resolve();
  const next = previous.then(run, run);
  progressQueue.set(mediaId, next);
  void next.finally(() => {
    if (progressQueue.get(mediaId) === next) progressQueue.delete(mediaId);
  });
  return next;
}

export function resetForProfile(): void {
  progressQueue.clear();
  watchingMarked.clear();
}

export async function markAnimeWatching(harborId: string, title: string): Promise<void> {
  if (!isAuthenticated()) return;
  const profileId = activeProfileId();
  const token = getSession()?.accessToken ?? null;
  if (!token) return;
  if (watchingMarked.has(harborId)) return;
  watchingMarked.add(harborId);
  try {
    const mediaId = await resolveAnilistMediaId(harborId);
    if (mediaId == null || activeProfileId() !== profileId) {
      watchingMarked.delete(harborId);
      return;
    }
    // The captured token is the third argument. Never pass a fourth: the client's
    // `skipAuth` flag nulls the token when true, which would send the write
    // anonymously.
    const cur = await anilistRequest<EntryResponse>(WATCHING_ENTRY_QUERY, { id: mediaId }, token);
    const entry = cur?.Media?.mediaListEntry;
    if (entry && entry.status !== "PLANNING") return;
    // The account can switch within the same profile after the entry is read.
    if (activeProfileId() !== profileId || getSession()?.accessToken !== token) return;
    await anilistRequest<{ SaveMediaListEntry: { id: number } | null }>(
      SAVE_STATUS_MUTATION,
      { mediaId, status: "CURRENT" },
      token,
    );
    emit({ kind: "watching", title });
  } catch (e) {
    watchingMarked.delete(harborId);
    if (e instanceof AnilistApiError && e.status === 401) return;
  }
}

export async function syncAnimeProgress(
  harborId: string,
  episode: number | undefined,
  title: string,
): Promise<void> {
  if (!isAuthenticated()) return;
  const ep = episode ?? 1;
  if (!Number.isFinite(ep) || ep < 1) return;

  // Bind the account before queueing: a profile switch while this episode waits
  // must not push it to whoever signs in next.
  const profileId = activeProfileId();
  const token = getSession()?.accessToken ?? null;
  if (!token) return;

  const mediaId = await resolveAnilistMediaId(harborId).catch(() => null);
  if (mediaId == null) return;
  if (activeProfileId() !== profileId) return;

  await enqueueProgressSync(mediaId, async () => {
    if (activeProfileId() !== profileId) return;
    const live = getSession();
    if (!live || live.accessToken !== token) return;
    await runAnimeProgressSync(
      mediaId,
      ep,
      createProgressSyncDeps({
        token,
        // Three arguments only: a fourth `true` is the client's `skipAuth` flag
        // and would clear the token, sending the write anonymously.
        request: (query, variables, requestToken) => anilistRequest(query, variables, requestToken),
        // Re-checked after the entry is read, so a profile or account switch
        // during that read cannot push the write to the wrong account.
        isStillValid: () =>
          isAuthenticated() &&
          activeProfileId() === profileId &&
          getSession()?.accessToken === token,
        emit: (event) => {
          if (event.kind === "error") emit({ kind: "error", title, message: event.message });
          else emit({ kind: event.kind, title, episode: event.episode });
        },
      }),
    );
  });
}
