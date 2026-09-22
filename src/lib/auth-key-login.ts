/**
 * Framework-free authentication-key sign-in primitives.
 *
 * Two pipelines live here, deliberately scoped apart:
 * - `performAuthKeyLogin` — the pre-existing browser-OAuth return path. It
 *   keeps the historical synthetic-user fallback so the baseline flow does
 *   not change.
 * - `performVerifiedAuthKeyLogin` — the strict pipeline for manually pasted
 *   keys: it commits only after `getUser` returns an actual user, never
 *   derives an identity from the secret, and never surfaces lookup error
 *   text (which could echo the key).
 */

export const NO_SIGN_IN_KEY_MESSAGE = "No sign-in key received. Try again.";
export const INVALID_AUTH_KEY_MESSAGE = "Invalid authentication key. Check it and try again.";

export type AuthKeyUser = { _id: string; email: string };

export type AuthKeySession = { authKey: string; user: AuthKeyUser };

/**
 * Machine-readable failure codes. Only these ever reach the UI — raw error
 * text from the network layer is never propagated, so untrusted server
 * messages that might contain the key cannot be displayed.
 */
export type AuthKeyErrorCode = "empty" | "invalid" | "failed" | "cancelled";

const ERROR_MESSAGES: Record<AuthKeyErrorCode, string> = {
  empty: NO_SIGN_IN_KEY_MESSAGE,
  invalid: INVALID_AUTH_KEY_MESSAGE,
  failed: "Sign-in failed",
  cancelled: "Sign-in cancelled",
};

export class AuthKeyLoginError extends Error {
  readonly code: AuthKeyErrorCode;
  constructor(code: AuthKeyErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "AuthKeyLoginError";
    this.code = code;
  }
}

/**
 * Ownership token for one manual sign-in attempt. Cancelling it (auth modal
 * closed, Escape, or cancel clicked while the lookup is in flight) makes the
 * attempt refuse to commit when the lookup finally resolves.
 */
export type AuthKeyRequest = { cancelled: boolean };

export function createAuthKeyRequest(): AuthKeyRequest {
  return { cancelled: false };
}

export function cancelAuthKeyRequest(request: AuthKeyRequest): void {
  request.cancelled = true;
}

/** The one validation every authentication-key sign-in goes through: trim, then reject empty. */
export function requireAuthKey(authKey: string): string {
  const key = authKey.trim();
  if (!key) throw new AuthKeyLoginError("empty");
  return key;
}

/**
 * Pre-existing browser-OAuth-return pipeline, preserved verbatim — including
 * the synthetic-user fallback — so the baseline browser flow does not change.
 * Do NOT use this for manually pasted keys: it commits even when the getUser
 * lookup fails. Manual entry must use `performVerifiedAuthKeyLogin`.
 */
export async function performAuthKeyLogin(
  authKey: string,
  deps: {
    fetchUser: (key: string) => Promise<AuthKeyUser | null>;
    commit: (session: AuthKeySession) => void;
  },
): Promise<void> {
  const key = requireAuthKey(authKey);
  const fetched = await deps.fetchUser(key).catch(() => null);
  const user: AuthKeyUser = fetched?._id
    ? fetched
    : { _id: `stremio:${key.slice(0, 10)}`, email: "" };
  deps.commit({ authKey: key, user });
}

/**
 * Strict pipeline for manually pasted keys: commits ONLY after the lookup
 * returns an actual user, and never after the request was cancelled while
 * the lookup was in flight. Lookup errors collapse into a fixed error code,
 * so untrusted server text can never reach the screen.
 */
export async function performVerifiedAuthKeyLogin(
  authKey: string,
  deps: {
    fetchUser: (key: string) => Promise<AuthKeyUser | null>;
    commit: (session: AuthKeySession) => void;
    request?: AuthKeyRequest;
  },
): Promise<void> {
  const key = requireAuthKey(authKey);
  let fetched: AuthKeyUser | null = null;
  let lookupFailed = false;
  try {
    fetched = await deps.fetchUser(key);
  } catch {
    lookupFailed = true;
  }
  if (deps.request?.cancelled) throw new AuthKeyLoginError("cancelled");
  if (lookupFailed) throw new AuthKeyLoginError("failed");
  if (!fetched?._id) throw new AuthKeyLoginError("invalid");
  deps.commit({ authKey: key, user: fetched });
}

/**
 * Result of one submit attempt. Success clears the field before the modal
 * closes; failure keeps the typed key for correction and carries only a
 * fixed error code — no raw error text, so nothing derived from the secret
 * can be displayed.
 */
export type AuthKeySubmitResult =
  | { signedIn: true; nextKey: "" }
  | { signedIn: false; nextKey: string; error: AuthKeyErrorCode };

export async function submitAuthKeyLogin(
  authKey: string,
  signIn: (authKey: string) => Promise<void>,
): Promise<AuthKeySubmitResult> {
  try {
    await signIn(authKey);
    return { signedIn: true, nextKey: "" };
  } catch (err) {
    return {
      signedIn: false,
      nextKey: authKey,
      error: err instanceof AuthKeyLoginError ? err.code : "failed",
    };
  }
}
