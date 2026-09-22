import type { Settings } from "../settings/types";

// Avoid optional background requests (and provider challenges) when skip features are off.
export type SkipPrefetchSettings = Pick<
  Settings,
  "showSkipButton" | "autoSkipIntro" | "autoSkipRecap" | "autoSkipOutro"
>;

export function skipPrefetchEnabled(settings: SkipPrefetchSettings): boolean {
  return (
    settings.showSkipButton ||
    settings.autoSkipIntro ||
    settings.autoSkipRecap ||
    settings.autoSkipOutro
  );
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
