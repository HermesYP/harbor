import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import {
  INVALID_AUTH_KEY_MESSAGE,
  NO_SIGN_IN_KEY_MESSAGE,
  cancelAuthKeyRequest,
  createAuthKeyRequest,
  submitAuthKeyLogin,
  type AuthKeyErrorCode,
  type AuthKeyRequest,
} from "@/lib/auth-key-login";
import { useT } from "@/lib/i18n";
import type { SignInMethod } from "@/lib/sign-in-gate";
import { Field } from "./field";

export function AuthKeyForm({
  onDone,
  pending,
  beginPending,
  endPending,
}: {
  onDone: () => void;
  pending: SignInMethod | null;
  beginPending: () => boolean;
  endPending: () => void;
}) {
  const { manualSignInWithKey } = useAuth();
  const t = useT();
  const [authKey, setAuthKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<AuthKeyRequest | null>(null);

  // The modal closed or was cancelled while the lookup was in flight: the
  // pending attempt must never complete afterwards.
  useEffect(() => {
    return () => {
      if (requestRef.current) cancelAuthKeyRequest(requestRef.current);
    };
  }, []);

  const busy = pending !== null;
  const canSubmit = !busy && authKey.trim().length > 0;

  // Only fixed, localized messages; raw lookup errors never reach the screen.
  const messageFor = (code: AuthKeyErrorCode): string => {
    if (code === "empty") return t(NO_SIGN_IN_KEY_MESSAGE);
    if (code === "invalid") return t(INVALID_AUTH_KEY_MESSAGE);
    return t("Sign-in failed");
  };

  const submit = async () => {
    if (!canSubmit) return;
    if (!beginPending()) return;
    setError(null);
    const request = createAuthKeyRequest();
    requestRef.current = request;
    const result = await submitAuthKeyLogin(authKey, (key) => manualSignInWithKey(key, request));
    if (request.cancelled) return;
    requestRef.current = null;
    setAuthKey(result.nextKey);
    if (result.signedIn) {
      onDone();
      return;
    }
    endPending();
    setError(messageFor(result.error));
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
        {pending === "key" ? (
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
