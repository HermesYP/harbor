import type { PlayerSrc } from "@/lib/view";
import type { DownloadItem } from "./downloads-store";

/**
 * The finished download whose metaId/season/episode match exactly, or null.
 *
 * Only `done` items are eligible: a downloading, errored, canceled, or
 * interrupted record points at an incomplete file and must never be played.
 * Pure and synchronous so callers outside React (episode navigation) can
 * consult the store without subscribing to per-chunk progress updates.
 */
export function findCompletedEpisodeDownload(
  items: DownloadItem[],
  metaId: string,
  season?: number | null,
  episode?: number | null,
): DownloadItem | null {
  for (const d of items) {
    if (d.status !== "done") continue;
    if (d.metaId !== metaId) continue;
    if (d.season !== season || d.episode !== episode) continue;
    return d;
  }
  return null;
}

/** Shared DownloadItem -> PlayerSrc shape for DownloadsView and episode navigation. */
export function downloadPlayerSrc(d: DownloadItem): PlayerSrc {
  return {
    meta: {
      id: d.metaId,
      type: d.season != null ? "series" : "movie",
      name: d.title,
      poster: d.poster ?? undefined,
    },
    url: d.path,
    title: d.title,
    subtitle: d.subtitle ?? undefined,
    notWebReady: true,
    episode:
      d.season != null && d.episode != null ? { season: d.season, episode: d.episode } : undefined,
  };
}
