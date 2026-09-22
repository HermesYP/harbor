import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { useT } from "@/lib/i18n";

export function Field({
  label,
  type,
  value,
  onChange,
  autoFocus,
  disabled,
  autoComplete,
  showLabel,
  hideLabel,
  onEnter,
}: {
  label: string;
  type: string;
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
  disabled?: boolean;
  autoComplete?: string;
  showLabel?: string;
  hideLabel?: string;
  onEnter?: () => void;
}) {
  const t = useT();
  const [show, setShow] = useState(false);
  const isPassword = type === "password";
  const revealShow = showLabel ?? t("Show password");
  const revealHide = hideLabel ?? t("Hide password");
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-subtle">
        {label}
      </span>
      <div className="relative">
        <input
          type={isPassword && show ? "text" : type}
          value={value}
          autoFocus={autoFocus}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={
            onEnter
              ? (e) => {
                  if (e.key !== "Enter") return;
                  // Stop Enter from implicitly submitting the surrounding
                  // e-mail form in every case — including Enter pressed while
                  // an IME composition is still open.
                  e.preventDefault();
                  if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
                  onEnter();
                }
              : undefined
          }
          spellCheck={false}
          autoComplete={autoComplete ?? (isPassword ? "current-password" : "email")}
          className={`h-11 w-full rounded-xl border border-edge bg-canvas px-3.5 text-[14px] text-ink outline-none transition-colors focus:border-ink disabled:opacity-50 ${
            isPassword ? "pe-11" : ""
          }`}
        />
        {isPassword && (
          <button
            type="button"
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setShow((v) => !v)}
            disabled={disabled}
            aria-label={show ? revealHide : revealShow}
            title={show ? revealHide : revealShow}
            className="absolute inset-y-0 end-0 flex w-11 items-center justify-center text-ink-subtle transition-colors hover:text-ink disabled:opacity-50"
          >
            {show ? <EyeOff size={17} strokeWidth={2} /> : <Eye size={17} strokeWidth={2} />}
          </button>
        )}
      </div>
    </label>
  );
}
