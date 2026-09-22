import { Check, ChevronDown, ChevronUp, ListVideo, X } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Poster } from "@/components/poster";
import { useCustomLists } from "@/lib/custom-lists";
import { fetchProfileLists, type ProfileListsResult } from "@/lib/anilist/lists";
import { useAnilist } from "@/lib/anilist/provider";
import { useT } from "@/lib/i18n";
import { currentAuthor, subscribeAuthor } from "@/lib/theme-auth";
import {
  MAX_FEATURED_LISTS,
  buildFeaturedPayload,
  fetchFeaturedLists,
  readLocalLists,
  saveFeaturedLists,
  toPickableList,
  type FeaturedList,
  type PickableList,
} from "@/lib/social/featured-lists";
import {
  hasUnprovenSelection,
  isSaveReady,
  publishableSelection,
  reconcileFeatured,
  type FeaturedPrivacy,
  type LoadedFeaturedFor,
} from "@/lib/social/featured-reconcile";

function ListRow({
  list,
  selected,
  ghost,
  disabled,
  onToggle,
}: {
  list: PickableList;
  selected: boolean;
  ghost?: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  return (
    <button
      onClick={onToggle}
      disabled={disabled}
      aria-pressed={selected}
      className={`flex w-full items-center gap-3 rounded-[10px] p-2.5 text-start ring-1 transition-colors disabled:opacity-40 ${
        selected ? "bg-elevated ring-edge" : "ring-edge-soft hover:bg-elevated"
      }`}
    >
      <span
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
          selected ? "bg-accent text-canvas" : "ring-1 ring-edge"
        }`}
      >
        {selected && <Check size={16} strokeWidth={3} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-medium text-ink">{list.name}</div>
        <div className="text-[12px] text-ink-subtle">
          {list.items.length} {list.items.length === 1 ? t("title") : t("titles")}
          {ghost && <span> · {t("not in your library")}</span>}
        </div>
      </div>
      <div className="flex shrink-0 gap-1">
        {list.items.slice(0, 4).map((item) => (
          <div key={item.id} className="w-8">
            <Poster
              src={item.poster || undefined}
              seed={item.name || item.id}
              ratio="portrait"
              className="rounded-[6px]"
            />
          </div>
        ))}
      </div>
    </button>
  );
}

function SelectedRow({
  list,
  index,
  total,
  ghost,
  onMoveUp,
  onMoveDown,
  onRemove,
}: {
  list: PickableList;
  index: number;
  total: number;
  ghost?: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  return (
    <div className="flex items-center gap-2.5 rounded-[10px] bg-elevated p-2.5 ring-1 ring-edge">
      <div className="flex shrink-0 flex-col">
        <button
          onClick={onMoveUp}
          disabled={index === 0}
          aria-label={t("Move up")}
          className="flex h-6 w-7 items-center justify-center rounded-t-[6px] text-ink-muted transition-colors hover:bg-surface hover:text-ink disabled:opacity-25"
        >
          <ChevronUp size={16} strokeWidth={2.5} />
        </button>
        <button
          onClick={onMoveDown}
          disabled={index === total - 1}
          aria-label={t("Move down")}
          className="flex h-6 w-7 items-center justify-center rounded-b-[6px] text-ink-muted transition-colors hover:bg-surface hover:text-ink disabled:opacity-25"
        >
          <ChevronDown size={16} strokeWidth={2.5} />
        </button>
      </div>
      <span className="w-4 shrink-0 text-center text-[13px] font-semibold tabular-nums text-ink-subtle">
        {index + 1}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-medium text-ink">{list.name}</div>
        <div className="text-[12px] text-ink-subtle">
          {list.items.length} {list.items.length === 1 ? t("title") : t("titles")}
          {ghost && <span> · {t("not in your library")}</span>}
        </div>
      </div>
      <div className="flex shrink-0 gap-1">
        {list.items.slice(0, 3).map((item) => (
          <div key={item.id} className="w-8">
            <Poster
              src={item.poster || undefined}
              seed={item.name || item.id}
              ratio="portrait"
              className="rounded-[6px]"
            />
          </div>
        ))}
      </div>
      <button
        onClick={onRemove}
        aria-label={t("Remove from featured")}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-surface hover:text-danger"
      >
        <X size={16} />
      </button>
    </div>
  );
}

export function MyListsPicker({ onClose }: { onClose?: () => void }) {
  const t = useT();
  const local = useCustomLists();
  const handle = useSyncExternalStore(subscribeAuthor, currentAuthor)?.handle ?? null;
  const { isConnected: anilistConnected, session: anilistSession } = useAnilist();
  const anilistUserId = anilistConnected ? (anilistSession?.userId ?? null) : null;
  // AniList candidates only become featureable after a fresh fetch verifies
  // them; cache fallback (and the pre-settle state) must never look
  // featureable, so unverified rows stay hidden.
  const [anilist, setAnilist] = useState<PickableList[]>([]);
  const [anilistNames, setAnilistNames] = useState<string[]>([]);
  const [anilistVerified, setAnilistVerified] = useState(false);
  const lists = useMemo(
    () => [...local.map(toPickableList), ...(anilistVerified ? anilist : [])],
    [local, anilist, anilistVerified],
  );
  const privacy = useMemo<FeaturedPrivacy>(
    () => ({ anilistNames, anilistVerified, anilistConnected: anilistUserId != null }),
    [anilistNames, anilistVerified, anilistUserId],
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [served, setServed] = useState<FeaturedList[]>([]);
  // A completed load belongs to one Harbor profile AND one AniList account;
  // either switch invalidates Save before the next fetch can settle.
  const [loadedFor, setLoadedFor] = useState<LoadedFeaturedFor | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sourceUnverified, setSourceUnverified] = useState(false);

  const { ghosts } = useMemo(
    () => reconcileFeatured(served, lists, anilistNames),
    [served, lists, anilistNames],
  );
  const entries = useMemo(() => [...lists, ...ghosts], [lists, ghosts]);
  const ghostIds = useMemo(() => new Set(ghosts.map((g) => g.id)), [ghosts]);
  const selectedEntries = useMemo(
    () =>
      selected.map((id) => entries.find((e) => e.id === id)).filter((l): l is PickableList => !!l),
    [selected, entries],
  );
  const unselectedEntries = useMemo(
    () => entries.filter((e) => !selected.includes(e.id)),
    [entries, selected],
  );
  // A selected row whose items may not be republished (e.g. a formerly
  // featured AniList list that is now all-private) blocks Save; the row's
  // remove button is the explicit way to drop it from the profile.
  const blocked = useMemo(
    () => hasUnprovenSelection(entries, selected, privacy),
    [entries, selected, privacy],
  );
  const overLimit = selected.length > MAX_FEATURED_LISTS;
  const ready = isSaveReady(loadedFor, handle, anilistUserId, anilistVerified, blocked || overLimit);

  useEffect(() => {
    // Drop everything derived from the previous account/state before fetching:
    // while the new fetch is pending (or fails), no candidates, verification,
    // or selection from the old load may remain featureable.
    setLoadedFor(undefined);
    setServed([]);
    setAnilist([]);
    setAnilistNames([]);
    setAnilistVerified(false);
    setSelected([]);
    setSourceUnverified(false);
    if (!handle) return;
    const ctrl = new AbortController();
    const unverified: ProfileListsResult = { lists: [], names: [], verified: false };
    const anilistReady =
      anilistUserId != null
        ? fetchProfileLists(anilistUserId).catch(() => unverified)
        : Promise.resolve(unverified);
    Promise.all([fetchFeaturedLists(handle, ctrl.signal), anilistReady])
      .then(([featured, profile]) => {
        if (ctrl.signal.aborted) return;
        setServed(featured);
        setAnilist(profile.lists);
        setAnilistNames(profile.names);
        setAnilistVerified(profile.verified);
        // Only verified AniList lists join the candidates; cached results
        // and disconnected profiles reconcile against local lists alone.
        const candidates = [...readLocalLists(), ...(profile.verified ? profile.lists : [])];
        setSelected(
          reconcileFeatured(featured, candidates, profile.names).selected,
        );
        if (anilistUserId != null && !profile.verified) {
          // A failed connected fetch cannot authorize republishing possibly
          // private served rows. Keep them visible and disable Save.
          setSourceUnverified(true);
          return;
        }
        setSourceUnverified(false);
        setLoadedFor({ handle, anilistUserId });
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, [handle, anilistUserId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const toggle = (id: string) => {
    setSelected((cur) => {
      if (cur.includes(id)) return cur.filter((x) => x !== id);
      if (cur.length >= MAX_FEATURED_LISTS) return cur;
      return [...cur, id];
    });
  };

  const move = (id: string, dir: -1 | 1) => {
    setSelected((cur) => {
      const i = cur.indexOf(id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= cur.length) return cur;
      const next = [...cur];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };

  const save = async () => {
    if (!ready || !handle || currentAuthor()?.handle !== handle) return;
    setSaving(true);
    setError(null);
    try {
      const picked = publishableSelection(entries, selected, privacy);
      await saveFeaturedLists(buildFeaturedPayload(picked, served, lists, anilistNames), true, handle);
      onClose?.();
    } catch {
      setError(t("Could not save. Try again."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[140] flex items-center justify-center p-4"
      role="dialog"
      aria-modal
    >
      <button aria-label={t("Close")} className="absolute inset-0 bg-black/55" onClick={onClose} />
      <div className="relative flex max-h-[88vh] w-full max-w-lg flex-col overflow-hidden rounded-[20px] bg-surface ring-1 ring-edge">
        <div className="flex items-center justify-between border-b border-edge-soft px-6 py-4">
          <h2 className="font-display text-[20px] text-ink">{t("Featured lists")}</h2>
          <button
            onClick={onClose}
            aria-label={t("Close")}
            className="flex h-11 w-11 items-center justify-center rounded-[10px] text-ink-muted hover:bg-elevated"
          >
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 space-y-2 overflow-y-auto px-6 py-5">
          <p className="pb-1 text-[13px] text-ink-muted">
            {t("Pick up to {max} lists to show on your public profile.", {
              max: MAX_FEATURED_LISTS,
            })}
          </p>
          {entries.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-[10px] border border-dashed border-edge py-12 text-center">
              <ListVideo size={24} className="text-ink-subtle" />
              <p className="mt-2 text-[14px] text-ink-muted">{t("You have no lists yet")}</p>
              <p className="mt-1 text-[12px] text-ink-subtle">
                {t("Create lists in your library to feature them here")}
              </p>
            </div>
          ) : (
            <>
              {selectedEntries.length > 0 && (
                <div className="space-y-2">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">
                    {t("Featured order")}
                  </div>
                  {selectedEntries.map((list, i) => (
                    <SelectedRow
                      key={list.id}
                      list={list}
                      index={i}
                      total={selectedEntries.length}
                      ghost={ghostIds.has(list.id)}
                      onMoveUp={() => move(list.id, -1)}
                      onMoveDown={() => move(list.id, 1)}
                      onRemove={() => toggle(list.id)}
                    />
                  ))}
                </div>
              )}
              {unselectedEntries.length > 0 && (
                <div className="space-y-2 pt-1">
                  {selectedEntries.length > 0 && (
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">
                      {t("Add a list")}
                    </div>
                  )}
                  {unselectedEntries.map((list) => (
                    <ListRow
                      key={list.id}
                      list={list}
                      selected={false}
                      ghost={ghostIds.has(list.id)}
                      disabled={selected.length >= MAX_FEATURED_LISTS}
                      onToggle={() => toggle(list.id)}
                    />
                  ))}
                </div>
              )}
            </>
          )}
          {blocked && (
            <p className="text-[13px] text-danger">
              {t("Some lists can no longer be featured. Remove them to save.")}
            </p>
          )}
          {overLimit && (
            <p className="text-[13px] text-danger">
              {t("Pick up to {max} lists to show on your public profile.", {
                max: MAX_FEATURED_LISTS,
              })}
            </p>
          )}
          {sourceUnverified && (
            <p className="text-[13px] text-danger">
              {t("Could not verify AniList lists. Reopen this picker to try again.")}
            </p>
          )}
          {error && <p className="text-[13px] text-danger">{error}</p>}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-edge-soft px-6 py-4">
          <span className="text-[13px] tabular-nums text-ink-subtle">
            {t("{selected}/{max} selected", { selected: selected.length, max: MAX_FEATURED_LISTS })}
          </span>
          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="inline-flex min-h-11 items-center rounded-[10px] px-4 text-[14px] font-medium text-ink-muted hover:bg-elevated"
            >
              {t("Cancel")}
            </button>
            <button
              onClick={() => void save()}
              disabled={saving || !ready}
              className="inline-flex min-h-11 items-center gap-2 rounded-[10px] bg-accent px-5 text-[14px] font-semibold text-canvas transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              <Check size={20} /> {saving ? t("Saving") : t("Save")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
