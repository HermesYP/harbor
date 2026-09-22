import type { Settings } from "../settings/types";

// Speculative background requests are gated separately from UI visibility.
// showSkipButton only controls the in-player Skip pill, which is fed by the
// on-demand playback fetch, so it must not grant prefetch permission here.
export type SkipPrefetchSettings = Pick<
  Settings,
  "autoSkipIntro" | "autoSkipRecap" | "autoSkipOutro"
>;

/**
 * Returns whether background provider warm-up is permitted. Only the
 * auto-skip settings count: showSkipButton defaults to true, so including it
 * would fire IntroDB requests for every default user on detail-page mount and
 * episode hover, re-triggering the Cloudflare challenge from
 * harborstremio/harbor#1187 without benefiting the Skip button, which
 * playback fetches on demand through useSkipSegments.
 */
export function skipPrefetchEnabled(settings: SkipPrefetchSettings): boolean {
  return settings.autoSkipIntro || settings.autoSkipRecap || settings.autoSkipOutro;
}

export type SkipPrefetchProviders = {
  aniskip: () => void;
  introDb: () => void;
};

/**
 * Runs the background skip-segment prefetches only while a skip feature that
 * consumes them is enabled. When disabled, no provider callback is invoked.
 */
export function prefetchSkipSegments(enabled: boolean, providers: SkipPrefetchProviders): void {
  if (!enabled) return;
  providers.aniskip();
  providers.introDb();
}
