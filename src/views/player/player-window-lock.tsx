import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { getCurrentWindow, PhysicalPosition } from "@tauri-apps/api/window";
import { LockKeyhole, LockKeyholeOpen } from "lucide-react";
import { createPlayerWindowLock } from "@/lib/player/window-lock";
import { useT } from "@/lib/i18n";

const IS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
type PlayerWindowLockState = {
  locked: boolean;
  busy: boolean;
  error: boolean;
  isLocked: () => boolean;
  setLocked: (value: boolean) => Promise<void>;
};
const Context = createContext<PlayerWindowLockState>({
  locked: false,
  busy: false,
  error: false,
  isLocked: () => false,
  setLocked: async (_value: boolean) => {},
});

export const usePlayerWindowLock = () => useContext(Context);

export function PlayerWindowLockProvider({ children }: { children: ReactNode }) {
  const [locked, setLockedState] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const controller = useMemo(() => {
    if (!IS_TAURI) return null;
    const win = getCurrentWindow();
    return createPlayerWindowLock({
      isResizable: () => win.isResizable(),
      isMaximizable: () => win.isMaximizable(),
      setMaximizable: (value) => win.setMaximizable(value),
      setResizable: (value) => win.setResizable(value),
      outerPosition: () => win.outerPosition(),
      setPosition: ({ x, y }) => win.setPosition(new PhysicalPosition(x, y)),
      onMoved: (fn) => win.onMoved(fn),
    });
  }, []);

  useEffect(() => {
    if (!controller) return;
    // Tauri's drag-region listener lives on document, outside React.
    const blockDrag = (event: MouseEvent) => {
      if (!controller.isLocked()) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const region = target.getAttribute("data-tauri-drag-region");
      if (region === null || region === "false") return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    document.addEventListener("mousedown", blockDrag, true);
    document.addEventListener("dblclick", blockDrag, true);
    document.addEventListener("mouseup", blockDrag, true);
    return () => {
      document.removeEventListener("mousedown", blockDrag, true);
      document.removeEventListener("dblclick", blockDrag, true);
      document.removeEventListener("mouseup", blockDrag, true);
      void controller
        .setLocked(false)
        .catch((cause) => console.warn("[player] unlock failed", cause));
    };
  }, [controller]);

  const setLocked = useCallback(
    async (value: boolean) => {
      if (!controller) return;
      setBusy(true);
      setError(false);
      try {
        await controller.setLocked(value);
        setLockedState(controller.isLocked());
      } catch (cause) {
        setError(true);
        throw cause;
      } finally {
        setBusy(false);
      }
    },
    [controller],
  );

  const value = useMemo(
    () => ({ locked, busy, error, isLocked: () => controller?.isLocked() ?? false, setLocked }),
    [locked, busy, error, controller, setLocked],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function PlayerWindowLockControl({ visible }: { visible: boolean }) {
  const { locked, busy, error, setLocked } = usePlayerWindowLock();
  const t = useT();
  if (!IS_TAURI) return null;
  const label = locked ? t("Unlock Player") : t("Lock Player");
  return (
    <div
      className={`pointer-events-auto absolute right-3 top-1/2 z-[110] flex flex-col items-end gap-2 ${visible || locked || error ? "" : "pointer-events-none opacity-0 focus-within:opacity-100"}`}
    >
      <button
        type="button"
        aria-label={label}
        aria-pressed={locked}
        title={label}
        disabled={busy}
        onClick={() => void setLocked(!locked).catch(() => {})}
        className="flex h-10 items-center gap-2 rounded-full border border-white/20 bg-black/70 px-3 text-xs text-white shadow-lg outline-offset-4 disabled:opacity-50"
      >
        {locked ? <LockKeyhole size={16} /> : <LockKeyholeOpen size={16} />}
        {locked && label}
      </button>
      {error && (
        <span role="alert" className="max-w-56 rounded bg-black/90 p-2 text-xs text-white">
          {t("Could not change player lock. Try again.")}
        </span>
      )}
    </div>
  );
}
