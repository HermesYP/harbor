// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import {
  SOCIAL_KEYS,
  SERVICES,
  getService,
  iconColor,
  isSocialKey,
  normalizeHandle,
  resolveUrl,
} from "../src/lib/social/socials.ts";

test("anilist is a registered social service with a working profile URL", () => {
  assert.ok(isSocialKey("anilist"));
  assert.ok(SOCIAL_KEYS.includes("anilist"));
  const svc = getService("anilist");
  assert.ok(svc);
  assert.equal(svc.label, "AniList");
  assert.equal(svc.urlTemplate, "https://anilist.co/user/{v}");
  assert.equal(resolveUrl("anilist", "some_user"), "https://anilist.co/user/some_user");
});

test("anilist handle normalization matches the shared rules", () => {
  assert.equal(normalizeHandle("anilist", "@Some_User"), "Some_User");
  assert.equal(normalizeHandle("anilist", "bad!handle#"), "badhandle");
  assert.equal(resolveUrl("anilist", ""), null);
  assert.equal(iconColor("anilist"), "#02A9FF");
});

test("every social key has exactly one service entry with an https-or-copy template", () => {
  assert.equal(new Set(SOCIAL_KEYS).size, SOCIAL_KEYS.length);
  assert.equal(new Set(SERVICES.map((s) => s.key)).size, SERVICES.length);
  for (const key of SOCIAL_KEYS) {
    const svc = getService(key);
    assert.ok(svc, `missing service for ${key}`);
    if (svc.urlTemplate) assert.match(svc.urlTemplate, /^https:\/\//);
    assert.ok(svc.iconPath.length > 0, `missing icon for ${key}`);
  }
});

test("registry stays in sync with the source-of-truth arrays", () => {
  const src = readFileSync(new URL("../src/lib/social/socials.ts", import.meta.url), "utf8");
  for (const key of SOCIAL_KEYS) {
    assert.match(src, new RegExp(`"${key}"`), `key ${key} missing from source`);
  }
  assert.equal(SERVICES.length, SOCIAL_KEYS.length);
});
