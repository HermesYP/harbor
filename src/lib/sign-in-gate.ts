/** The sign-in methods that share one pending gate inside the auth modal. */
export type SignInMethod = "email" | "browser" | "key";

/**
 * Synchronous pending gate shared by every sign-in method in the auth modal
 * so two submissions (for example rapid Enter presses across fields) can
 * never run concurrently: the first `tryBegin()` wins until `end()`. React
 * state mirrors the owner for rendering; this gate is the re-entry truth for
 * the same event tick, before a re-render has disabled the other controls.
 */
export function createSignInGate(): {
  owner: () => SignInMethod | null;
  tryBegin: (method: SignInMethod) => boolean;
  end: () => void;
} {
  let owner: SignInMethod | null = null;
  return {
    owner: () => owner,
    tryBegin: (method) => {
      if (owner !== null) return false;
      owner = method;
      return true;
    },
    end: () => {
      owner = null;
    },
  };
}
