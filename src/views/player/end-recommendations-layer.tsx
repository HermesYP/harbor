import { memo, useEffect, useRef } from "react";
import { X } from "lucide-react";
import { PickCard } from "@/components/pick-card";
import type { Meta } from "@/lib/cinemeta";
import { useT } from "@/lib/i18n";
import { useView } from "@/lib/view";

/**
 * Full-screen "More Like This" rail shown once a movie or a series finale
 * finishes naturally. It never touches playback: dismissing runs the same
 * close path the old auto-close used, and picking a card leaves the player
 * the same way the cast modal's "open detail" action does.
 */
export const EndRecommendationsLayer = memo(function EndRecommendationsLayer({
  visible,
  items,
  finishedTitle,
  onDismiss,
}: {
  visible: boolean;
  items: Meta[];
  finishedTitle: string;
  onDismiss: () => void;
}) {
  const t = useT();
  const { exitPlayer } = useView();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (visible) containerRef.current?.focus();
  }, [visible]);

  if (!visible || items.length === 0) return null;

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      data-end-recommendations
      className="absolute inset-0 z-[95] flex flex-col justify-end overflow-hidden bg-gradient-to-t from-black/95 via-black/75 to-black/30 px-6 pb-10 pt-20 outline-none sm:px-10"
    >
      <div className="mb-4 flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 className="font-display text-[clamp(22px,3.2vw,32px)] font-semibold leading-tight text-white">
            {t("More Like This")}
          </h2>
          <p className="line-clamp-1 text-sm text-white/70">{finishedTitle}</p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t("Close")}
          className="flex h-10 shrink-0 items-center gap-2 rounded-full bg-white/10 px-4 text-sm font-semibold text-white ring-1 ring-white/25 transition-colors hover:bg-white/20"
        >
          <X size={16} strokeWidth={2.5} />
          {t("Close")}
        </button>
      </div>
      <div className="flex gap-4 overflow-x-auto pb-2">
        {items.map((meta) => (
          <div
            key={meta.id}
            className="w-32 shrink-0 sm:w-40"
            onClickCapture={() => {
              // Strip the player frame first so the card's own openMeta lands
              // on the detail frame (same ordering as the cast modal's
              // onOpenDetail). Capture runs before the card's own handler.
              exitPlayer();
            }}
          >
            <PickCard meta={meta} />
          </div>
        ))}
      </div>
    </div>
  );
});
