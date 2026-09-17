import type { MediaListStatus } from "./types.ts";
import { decideAnimeProgress, type EntryState } from "./progress-decision.ts";

export type SavedEntryState = {
  progress: number;
  status: MediaListStatus;
  repeat: number;
};

export type ProgressSyncEvent =
  | { kind: "syncing"; episode: number }
  | { kind: "ok"; episode: number }
  | { kind: "error"; message: string };

/**
 * Everything a push needs, with the account already resolved. The token is
 * bound to one signed-in profile before the push is queued, so a profile switch
 * cannot redirect a write that was started for another account.
 */
export type ProgressSyncDeps = {
  getToken(): string | null;
  request(query: string, variables: Record<string, unknown>, token: string): Promise<unknown>;
  emit(event: ProgressSyncEvent): void;
  /** False once the account the push was started for is no longer signed in. */
  isStillValid?(): boolean;
};

export type ProgressSyncAdapterOptions = {
  token: string;
  request(query: string, variables: Record<string, unknown>, token: string): Promise<unknown>;
  emit(event: ProgressSyncEvent): void;
  isStillValid?(): boolean;
};

export const ENTRY_QUERY = `query ($id: Int) {
  Media(id: $id, type: ANIME) {
    id
    episodes
    mediaListEntry { id progress status repeat }
  }
}`;

export const PROGRESS_MUTATION = `mutation ($mediaId: Int, $progress: Int, $status: MediaListStatus, $repeat: Int) {
  SaveMediaListEntry(mediaId: $mediaId, progress: $progress, status: $status, repeat: $repeat) {
    id
    progress
    status
    repeat
  }
}`;

type EntryResponse = {
  Media: {
    id: number;
    episodes: number | null;
    mediaListEntry: (EntryState & { id: number }) | null;
  } | null;
};

type ProgressResponse = { SaveMediaListEntry: SavedEntryState | null };

/**
 * Bind a push to one signed-in profile.
 *
 * The request callback is injected by the caller, which is where the token is
 * attached to the real API call. Every decision is taken from the entry AniList
 * reports for that token, so no local state can go stale between pushes.
 */ export function createProgressSyncDeps(options: ProgressSyncAdapterOptions): ProgressSyncDeps {
  return {
    getToken: () => options.token,
    request: options.request,
    isStillValid: options.isStillValid ?? (() => true),
    emit: options.emit,
  };
}

/**
 * Push one finished episode to AniList.
 *
 * Forward progress stays forward progress. A rewatch is tracked only where
 * AniList already reports the entry as REPEATING; reaching the episode total
 * then completes the entry and moves `repeat` one past the value the live entry
 * reports, so a repeated report of the same finale writes that same value again
 * instead of counting twice. Callers serialize pushes per media.
 */
export async function runAnimeProgressSync(
  mediaId: number,
  episode: number,
  deps: ProgressSyncDeps,
): Promise<void> {
  const token = deps.getToken();
  if (!token) return;

  try {
    const state = (await deps.request(ENTRY_QUERY, { id: mediaId }, token)) as
      | EntryResponse
      | undefined;
    const media = state?.Media;
    if (!media) return;

    const total = media.episodes ?? 0;
    const decision = decideAnimeProgress(media.mediaListEntry, episode, total);
    if (decision.action === "skip") return;

    // The account can change while the entry is being read: never write for a
    // profile that is no longer the signed-in one.
    if (deps.isStillValid && !deps.isStillValid()) return;

    deps.emit({ kind: "syncing", episode });

    const variables: Record<string, unknown> = {
      mediaId,
      progress: decision.progress,
      status: decision.status,
    };
    if (decision.repeat != null) variables.repeat = decision.repeat;

    const saved = (await deps.request(PROGRESS_MUTATION, variables, token)) as
      | ProgressResponse
      | undefined;
    const result = saved?.SaveMediaListEntry;

    // The write only counts once AniList reports back what was asked for.
    const confirmed =
      !!result &&
      result.progress === decision.progress &&
      result.status === decision.status &&
      (decision.repeat == null || result.repeat === decision.repeat);

    if (!confirmed) {
      deps.emit({ kind: "error", message: "AniList did not confirm the update." });
      return;
    }

    deps.emit({ kind: "ok", episode });
  } catch {
    deps.emit({ kind: "error", message: "Couldn't reach AniList." });
  }
}
