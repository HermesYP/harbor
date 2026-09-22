// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import {
  AuthKeyLoginError,
  INVALID_AUTH_KEY_MESSAGE,
  NO_SIGN_IN_KEY_MESSAGE,
  cancelAuthKeyRequest,
  createAuthKeyRequest,
  performAuthKeyLogin,
  performVerifiedAuthKeyLogin,
  requireAuthKey,
  submitAuthKeyLogin,
  type AuthKeyRequest,
  type AuthKeySession,
  type AuthKeyUser,
} from "../src/lib/auth-key-login.ts";
import { createSignInGate } from "../src/lib/sign-in-gate.ts";

const VALID_USER: AuthKeyUser = { _id: "user-1", email: "sub@example.com" };

/** A user lookup that only settles when the test says so. */
function deferredUser(): {
  lookup: () => Promise<AuthKeyUser | null>;
  resolve: (user: AuthKeyUser | null) => void;
} {
  let settle: (user: AuthKeyUser | null) => void = () => {};
  return {
    lookup: () =>
      new Promise<AuthKeyUser | null>((resolve) => {
        settle = resolve;
      }),
    resolve: (user) => settle(user),
  };
}

/** Runs the strict (manual-entry) pipeline over a caller-supplied lookup. */
function verifiedPipeline(lookup: (key: string) => Promise<AuthKeyUser | null>) {
  const state: { committed: AuthKeySession[]; fetchedKeys: string[] } = {
    committed: [],
    fetchedKeys: [],
  };
  const signIn = (authKey: string, request?: AuthKeyRequest) =>
    performVerifiedAuthKeyLogin(authKey, {
      fetchUser: (key) => {
        state.fetchedKeys.push(key);
        return lookup(key);
      },
      commit: (session) => {
        state.committed.push(session);
      },
      request,
    });
  return { state, signIn };
}

test("requireAuthKey trims the key and rejects an empty one with a typed error", () => {
  assert.equal(requireAuthKey("  abc123  \n"), "abc123");
  for (const bad of ["", "   \n "]) {
    assert.throws(
      () => requireAuthKey(bad),
      (err: unknown) =>
        err instanceof AuthKeyLoginError &&
        err.code === "empty" &&
        err.message === NO_SIGN_IN_KEY_MESSAGE,
    );
  }
});

test("browser-return pipeline commits the fetched user (baseline flow unchanged)", async () => {
  const committed: AuthKeySession[] = [];
  await performAuthKeyLogin("  key-1  ", {
    fetchUser: async () => VALID_USER,
    commit: (session) => committed.push(session),
  });
  assert.deepEqual(committed, [{ authKey: "key-1", user: VALID_USER }]);
});

test("browser-return pipeline keeps the synthetic-user fallback (baseline flow unchanged)", async () => {
  const committed: AuthKeySession[] = [];
  await performAuthKeyLogin("abcdef1234567890", {
    fetchUser: async () => {
      throw new Error("offline");
    },
    commit: (session) => committed.push(session),
  });
  assert.deepEqual(committed, [
    { authKey: "abcdef1234567890", user: { _id: "stremio:abcdef1234", email: "" } },
  ]);
});

test("manual pipeline commits only a validated, trimmed key with the real fetched user", async () => {
  const { state, signIn } = verifiedPipeline(async () => VALID_USER);

  await signIn("  abc123  ");

  assert.deepEqual(state.fetchedKeys, ["abc123"]);
  assert.deepEqual(state.committed, [{ authKey: "abc123", user: VALID_USER }]);
});

test("manual pipeline does not commit when the lookup returns no user", async () => {
  const { state, signIn } = verifiedPipeline(async () => null);

  await assert.rejects(
    signIn("bad-key-42"),
    (err: unknown) => err instanceof AuthKeyLoginError && err.code === "invalid",
  );
  assert.deepEqual(state.committed, []);
});

test("manual pipeline does not commit a user without an identity", async () => {
  const { state, signIn } = verifiedPipeline(async () => ({ _id: "", email: "" }));

  await assert.rejects(
    signIn("bad-key-42"),
    (err: unknown) => err instanceof AuthKeyLoginError && err.code === "invalid",
  );
  assert.deepEqual(state.committed, []);
});

test("manual pipeline never derives an identity from the secret on failure", async () => {
  // A key shaped like the old fallback input must not produce a session or a
  // manufactured `stremio:<secret-prefix>` user anywhere in the strict path.
  const { state, signIn } = verifiedPipeline(async () => null);

  await assert.rejects(
    signIn("stremio:abcdef1234567890"),
    (err: unknown) => err instanceof AuthKeyLoginError && err.code === "invalid",
  );
  assert.deepEqual(state.committed, []);
});

test("lookup errors never commit and never leak the key into surfaced text", async () => {
  const key = "secret-key-456";
  const { state, signIn } = verifiedPipeline(async () => {
    // Simulate a server/transport error that echoes the key back.
    throw new Error(`server rejected authKey ${key}`);
  });

  await assert.rejects(signIn(key), (err: unknown) => {
    assert.ok(err instanceof AuthKeyLoginError);
    const loginError = err as AuthKeyLoginError;
    assert.equal(loginError.code, "failed");
    assert.equal(loginError.message, "Sign-in failed");
    assert.ok(!loginError.message.includes(key));
    return true;
  });
  assert.deepEqual(state.committed, []);

  const result = await submitAuthKeyLogin(key, (k) => signIn(k));
  assert.deepEqual(result, { signedIn: false, nextKey: key, error: "failed" });
});

test("failed submit keeps the typed key and surfaces only a fixed error code", async () => {
  const result = await submitAuthKeyLogin("bad-key-42", () =>
    Promise.reject(new Error("stremio rejected the key with bad-key-42 inside")),
  );
  // The raw server text (which may contain the key) is dropped entirely.
  assert.deepEqual(result, { signedIn: false, nextKey: "bad-key-42", error: "failed" });
  assert.equal((result as { message?: string }).message, undefined);
});

test("non-Error failures also collapse to the fixed failed code", async () => {
  const result = await submitAuthKeyLogin("bad-key-42", () => Promise.reject("boom"));
  assert.deepEqual(result, { signedIn: false, nextKey: "bad-key-42", error: "failed" });
});

test("successful submit clears the field before the modal closes", async () => {
  const { signIn } = verifiedPipeline(async () => VALID_USER);

  const result = await submitAuthKeyLogin("key-123", (k) => signIn(k));

  assert.deepEqual(result, { signedIn: true, nextKey: "" });
});

test("empty submission surfaces the shared validation without fetching or committing", async () => {
  const { state, signIn } = verifiedPipeline(async () => VALID_USER);

  const result = await submitAuthKeyLogin("   \n", (k) => signIn(k));

  assert.deepEqual(result, { signedIn: false, nextKey: "   \n", error: "empty" });
  assert.deepEqual(state.fetchedKeys, []);
  assert.deepEqual(state.committed, []);
});

test("a request cancelled mid-lookup never completes, even when a valid user returns", async () => {
  const pending = deferredUser();
  const { state, signIn } = verifiedPipeline(pending.lookup);
  const request = createAuthKeyRequest();

  const attempt = signIn("secret-key-789", request);
  assert.deepEqual(state.fetchedKeys, ["secret-key-789"], "lookup must start synchronously");
  cancelAuthKeyRequest(request);
  pending.resolve(VALID_USER);

  await assert.rejects(
    attempt,
    (err: unknown) => err instanceof AuthKeyLoginError && err.code === "cancelled",
  );
  assert.deepEqual(state.committed, []);
});

test("a stale submit result after cancellation reports cancelled, not success", async () => {
  const pending = deferredUser();
  const { state, signIn } = verifiedPipeline(pending.lookup);
  const request = createAuthKeyRequest();

  const resultPromise = submitAuthKeyLogin("secret-key-789", (k) => signIn(k, request));
  cancelAuthKeyRequest(request);
  pending.resolve(VALID_USER);

  assert.deepEqual(await resultPromise, {
    signedIn: false,
    nextKey: "secret-key-789",
    error: "cancelled",
  });
  assert.deepEqual(state.committed, []);
});

test("the shared sign-in gate refuses a second concurrent submission until released", () => {
  const gate = createSignInGate();
  assert.equal(gate.owner(), null);
  assert.equal(gate.tryBegin("email"), true);
  assert.equal(gate.owner(), "email");
  // Same-tick re-entry from another method is rejected while email is pending.
  assert.equal(gate.tryBegin("key"), false);
  assert.equal(gate.tryBegin("browser"), false);
  assert.equal(gate.owner(), "email");
  gate.end();
  assert.equal(gate.owner(), null);
  assert.equal(gate.tryBegin("key"), true);
  assert.equal(gate.owner(), "key");
});

const keyFormSource = readFileSync(
  new URL("../src/components/auth-modal/auth-key-form.tsx", import.meta.url),
  "utf8",
);
const modalSource = readFileSync(
  new URL("../src/components/auth-modal.tsx", import.meta.url),
  "utf8",
);
const fieldSource = readFileSync(
  new URL("../src/components/auth-modal/field.tsx", import.meta.url),
  "utf8",
);
const webButtonSource = readFileSync(
  new URL("../src/components/auth-modal/stremio-web-button.tsx", import.meta.url),
  "utf8",
);
const authLibSource = readFileSync(new URL("../src/lib/auth.tsx", import.meta.url), "utf8");
const loginLibSource = readFileSync(
  new URL("../src/lib/auth-key-login.ts", import.meta.url),
  "utf8",
);
const enCatalog = JSON.parse(
  readFileSync(new URL("../src/lib/i18n/locales/en.json", import.meta.url), "utf8"),
) as Record<string, string>;

function includes(source: string, text: string): void {
  assert.ok(source.includes(text), `expected source to include: ${text}`);
}

test("authentication-key entry is masked, off the password manager, and never logged", () => {
  includes(keyFormSource, 'type="password"');
  includes(keyFormSource, 'autoComplete="off"');
  includes(keyFormSource, 'showLabel={t("Show authentication key")}');
  includes(keyFormSource, 'hideLabel={t("Hide authentication key")}');
  assert.doesNotMatch(keyFormSource, /console\./);
  assert.doesNotMatch(loginLibSource, /console\./);
  assert.doesNotMatch(authLibSource, /console\./);
  assert.doesNotMatch(modalSource, /console\./);
});

test("key form uses the strict manual pipeline with request ownership", () => {
  includes(keyFormSource, "const { manualSignInWithKey } = useAuth();");
  includes(keyFormSource, "manualSignInWithKey(key, request)");
  includes(keyFormSource, "createAuthKeyRequest()");
  includes(keyFormSource, "cancelAuthKeyRequest(requestRef.current)");
  includes(keyFormSource, "if (request.cancelled) return;");
  // The cancellation guard must run before anything is applied or closed.
  assert.ok(
    keyFormSource.indexOf("if (request.cancelled) return;") < keyFormSource.indexOf("onDone();"),
    "cancelled results must be discarded before completing the sign-in",
  );
  includes(keyFormSource, "authKey.trim().length > 0");
  includes(authLibSource, "performVerifiedAuthKeyLogin(authKey, {");
});

test("key form coordinates pending state and maps errors to fixed localized text only", () => {
  includes(keyFormSource, "const busy = pending !== null;");
  includes(keyFormSource, "if (!beginPending()) return;");
  includes(keyFormSource, "endPending();");
  includes(keyFormSource, 'pending === "key"');
  includes(keyFormSource, "disabled={busy}");
  includes(keyFormSource, "t(NO_SIGN_IN_KEY_MESSAGE)");
  includes(keyFormSource, "t(INVALID_AUTH_KEY_MESSAGE)");
  includes(keyFormSource, 't("Sign-in failed")');
  // Raw error text must never be shown on the key path.
  assert.doesNotMatch(keyFormSource, /result\.message|err\.message|\.message \?\?/);
});

test("auth modal gates every sign-in method through one pending slot", () => {
  includes(modalSource, "createSignInGate()");
  includes(modalSource, 'if (!tryBegin("email")) return;');
  includes(modalSource, 'tryBegin("browser")');
  includes(modalSource, 'tryBegin("key")');
  includes(modalSource, "const busy = pending !== null;");
  includes(modalSource, "beginPending={beginBrowser}");
  includes(modalSource, "beginPending={beginKey}");
  includes(modalSource, "endPending={endPending}");
  includes(modalSource, 'pending === "email"');
  // While any method is pending, both e-mail fields, the remember toggle,
  // and the browser button are disabled.
  assert.ok((modalSource.match(/disabled=\{busy\}/g) ?? []).length >= 3);
  includes(modalSource, "disabled={busy || !email || !password}");
});

test("auth modal still exposes the baseline web and e-mail flows untouched", () => {
  includes(modalSource, "signIn(email, password, remember)");
  includes(modalSource, 'type="submit"');
  includes(modalSource, "max-h-[92vh]");
  assert.equal((modalSource.match(/<Field\b/g) ?? []).length, 2);
  // The browser-return path keeps the pre-existing (non-strict) pipeline.
  includes(webButtonSource, "signInWithKey(key)");
  includes(webButtonSource, "if (beginPending && !beginPending()) return;");
  includes(webButtonSource, "endPending?.()");
  includes(authLibSource, "performAuthKeyLogin(authKey, {");
});

test("manual sign-in rejects commits to a different profile than the one that started it", () => {
  includes(authLibSource, "manualSignInWithKey");
  includes(authLibSource, "activeProfileIdRef.current = activeProfile?.id ?? null");
  includes(authLibSource, "if (activeProfileIdRef.current !== expectedProfileId) {");
  includes(authLibSource, 'throw new AuthKeyLoginError("cancelled");');
  assert.ok(
    authLibSource.indexOf("if (activeProfileIdRef.current !== expectedProfileId) {") <
      authLibSource.indexOf("commitSession(fresh)"),
    "the stale-profile guard must run before the session is written",
  );
});

test("key field Enter handling never implicitly submits the e-mail form, IME included", () => {
  includes(fieldSource, 'e.key !== "Enter"');
  includes(fieldSource, "onEnter");
  includes(fieldSource, "autoComplete ?? (isPassword");
  includes(fieldSource, "aria-label={show ? revealHide : revealShow}");
  const handler = fieldSource.slice(fieldSource.indexOf("onKeyDown"));
  const prevent = handler.indexOf("e.preventDefault()");
  const composing = handler.indexOf("e.nativeEvent.isComposing");
  const action = handler.indexOf("onEnter();");
  assert.ok(prevent !== -1 && composing !== -1 && action !== -1);
  assert.ok(
    prevent < composing,
    "preventDefault must run before the composing guard so mid-IME Enter cannot submit the form",
  );
  assert.ok(composing < action, "sign-in must not trigger during an IME composition");
});

test("key sign-in error strings exist in the source i18n catalog", () => {
  assert.equal(enCatalog[NO_SIGN_IN_KEY_MESSAGE], NO_SIGN_IN_KEY_MESSAGE);
  assert.equal(enCatalog[INVALID_AUTH_KEY_MESSAGE], INVALID_AUTH_KEY_MESSAGE);
  assert.equal(enCatalog["Sign in with key"], "Sign in with key");
});
