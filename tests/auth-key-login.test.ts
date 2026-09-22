// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import {
  NO_SIGN_IN_KEY_MESSAGE,
  performAuthKeyLogin,
  requireAuthKey,
  submitAuthKeyLogin,
  type AuthKeySession,
} from "../src/lib/auth-key-login.ts";

function pipeline() {
  const state: {
    committed: AuthKeySession | null;
    fetchedKeys: string[];
    fetchShouldFail: boolean;
  } = { committed: null, fetchedKeys: [], fetchShouldFail: false };
  const signInWithKey = (authKey: string) =>
    performAuthKeyLogin(authKey, {
      fetchUser: async (key) => {
        state.fetchedKeys.push(key);
        if (state.fetchShouldFail) throw new Error("offline");
        return { _id: "user-1", email: "sub@example.com" };
      },
      commit: (session) => {
        state.committed = session;
      },
    });
  return { state, signInWithKey };
}

test("existing signInWithKey validation trims the key and rejects an empty one", () => {
  assert.equal(requireAuthKey("  abc123  \n"), "abc123");
  assert.throws(() => requireAuthKey(""), { message: NO_SIGN_IN_KEY_MESSAGE });
  assert.throws(() => requireAuthKey("   \n "), { message: NO_SIGN_IN_KEY_MESSAGE });
});

test("successful key login commits the trimmed key with the fetched user", async () => {
  const { state, signInWithKey } = pipeline();

  await signInWithKey("  abc123  ");

  assert.deepEqual(state.fetchedKeys, ["abc123"]);
  assert.deepEqual(state.committed, {
    authKey: "abc123",
    user: { _id: "user-1", email: "sub@example.com" },
  });
});

test("key login keeps the existing synthetic-user fallback when getUser fails", async () => {
  const { state, signInWithKey } = pipeline();
  state.fetchShouldFail = true;

  await signInWithKey("abcdef1234567890");

  assert.deepEqual(state.committed, {
    authKey: "abcdef1234567890",
    user: { _id: "stremio:abcdef1234", email: "" },
  });
});

test("successful submit clears the field before the modal closes", async () => {
  const { signInWithKey } = pipeline();

  const result = await submitAuthKeyLogin("key-123", signInWithKey);

  assert.deepEqual(result, { signedIn: true, nextKey: "" });
});

test("failed submit keeps the typed key and surfaces the failure message", async () => {
  const result = await submitAuthKeyLogin("bad-key-42", async () => {
    throw new Error("stremio rejected the key");
  });

  assert.deepEqual(result, {
    signedIn: false,
    nextKey: "bad-key-42",
    message: "stremio rejected the key",
  });
});

test("non-Error failures carry no message so the UI falls back to localized text", async () => {
  const result = await submitAuthKeyLogin("bad-key-42", () => Promise.reject("boom"));

  assert.deepEqual(result, { signedIn: false, nextKey: "bad-key-42", message: null });
});

test("empty submission surfaces the shared validation message without fetching or committing", async () => {
  const { state, signInWithKey } = pipeline();

  const result = await submitAuthKeyLogin("   \n", signInWithKey);

  assert.deepEqual(result, {
    signedIn: false,
    nextKey: "   \n",
    message: NO_SIGN_IN_KEY_MESSAGE,
  });
  assert.deepEqual(state.fetchedKeys, []);
  assert.equal(state.committed, null);
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
const authLibSource = readFileSync(new URL("../src/lib/auth.tsx", import.meta.url), "utf8");
const loginLibSource = readFileSync(
  new URL("../src/lib/auth-key-login.ts", import.meta.url),
  "utf8",
);

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

test("key form reuses the shared sign-in pipeline and applies the field-clearing result", () => {
  includes(keyFormSource, "submitAuthKeyLogin(authKey, signInWithKey)");
  includes(keyFormSource, "setAuthKey(result.nextKey)");
  includes(keyFormSource, 'setError(result.message ?? t("Sign-in failed"))');
  includes(keyFormSource, "onDone();");
  includes(keyFormSource, "authKey.trim().length > 0");
  includes(authLibSource, "performAuthKeyLogin(authKey, {");
});

test("auth modal exposes the key path beside web and email sign-in without regressions", () => {
  includes(modalSource, "<AuthKeyForm onDone={onClose} disabled={busy} />");
  includes(modalSource, 't("or use authentication key")');
  includes(modalSource, "max-h-[92vh]");
  includes(modalSource, "signIn(email, password, remember)");
  includes(modalSource, 'type="submit"');
  assert.equal((modalSource.match(/<Field\b/g) ?? []).length, 2);
});

test("key field keeps TV navigation semantics: explicit Enter handling, no implicit e-mail submit", () => {
  includes(fieldSource, "e.preventDefault()");
  includes(fieldSource, "onEnter");
  includes(fieldSource, "autoComplete ?? (isPassword");
  includes(fieldSource, "aria-label={show ? revealHide : revealShow}");
});
