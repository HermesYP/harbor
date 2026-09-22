import { Loader2 } from "lucide-react";
import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { submitAuthKeyLogin } from "@/lib/auth-key-login";
import { useT } from "@/lib/i18n";
import { Field } from "./field";

export function AuthKeyForm({ onDone, disabled }: { onDone: () => void; disabled?: boolean }) {
  const { signInWithKey } = useAuth();
  const t = useT();
  const [authKey, setAuthKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = !busy && !disabled && authKey.trim().length > 0;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const result = await submitAuthKeyLogin(authKey, signInWithKey);
    setAuthKey(result.nextKey);
    setBusy(false);
    if (result.signedIn) {
      onDone();
      return;
    }
    setError(result.message ?? t("Sign-in failed"));
  };

  return (
    <div className="flex flex-col gap-3">
      <Field
        label={t("Authentication key")}
        type="password"
        value={authKey}
        onChange={setAuthKey}
        disabled={busy}
        autoComplete="off"
        showLabel={t("Show authentication key")}
        hideLabel={t("Hide authentication key")}
        onEnter={() => void submit()}
      />
      <p className="text-center text-[11.5px] leading-snug text-ink-subtle">
        {t("Paste the authentication key from your Stremio profile.")}
      </p>
      {error && (
        <p className="rounded-lg bg-danger/15 px-3 py-2 text-[12.5px] text-danger">{error}</p>
      )}
      <button
        type="button"
        onClick={() => void submit()}
        disabled={!canSubmit}
        className="flex h-11 items-center justify-center gap-2 rounded-xl border border-edge bg-elevated text-[14px] font-semibold text-ink transition-colors hover:bg-raised disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? (
          <>
            <Loader2 size={15} className="animate-spin" />
            {t("Signing in...")}
          </>
        ) : (
          t("Sign in with key")
        )}
      </button>
    </div>
  );
}
