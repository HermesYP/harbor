export const NO_SIGN_IN_KEY_MESSAGE = "No sign-in key received. Try again.";

export type AuthKeyUser = { _id: string; email: string };

export type AuthKeySession = { authKey: string; user: AuthKeyUser };

/** The one validation every authentication-key sign-in goes through: trim, then reject empty. */
export function requireAuthKey(authKey: string): string {
  const key = authKey.trim();
  if (!key) throw new Error(NO_SIGN_IN_KEY_MESSAGE);
  return key;
}

/**
 * Signs in with a raw authentication key. Kept framework-free so the existing
 * validation, trimming, and user fallback behave identically for every caller.
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
 * Result of one submit attempt. Success clears the field before the modal
 * closes; failure keeps the typed key so the user can correct it and carries
 * only the error message (never the key itself) for display.
 */
export type AuthKeySubmitResult =
  | { signedIn: true; nextKey: "" }
  | { signedIn: false; nextKey: string; message: string | null };

export async function submitAuthKeyLogin(
  authKey: string,
  signInWithKey: (authKey: string) => Promise<void>,
): Promise<AuthKeySubmitResult> {
  try {
    await signInWithKey(authKey);
    return { signedIn: true, nextKey: "" };
  } catch (err) {
    return {
      signedIn: false,
      nextKey: authKey,
      message: err instanceof Error && err.message ? err.message : null,
    };
  }
}
