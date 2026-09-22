// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import { APP_VERSION } from "../src/lib/build-info.ts";
import {
  SIMKL_API_BASE,
  SIMKL_APP_NAME,
  SIMKL_APP_VERSION,
  SIMKL_CLIENT_ID,
} from "../src/lib/simkl/config.ts";

// client.ts sends `client_id`, `app-name`, and `app-version` on every Simkl request.
// The API deterministically answers 403 "Blocked. Please contact support@simkl.com" to
// the frozen app-name/app-version pair harborstremio/harbor#1336 shipped (harbor/0.9.75),
// which surfaced as "Simkl HTTP 403: Blocked…" on Connect Simkl. The version must always
// track the build version instead of a hardcoded literal that drifts out of date.
test("Simkl app-version tracks the build version", () => {
  assert.equal(SIMKL_APP_VERSION, APP_VERSION);
});

test("Simkl request identity stays stable", () => {
  assert.equal(SIMKL_API_BASE, "https://api.simkl.com");
  assert.equal(SIMKL_APP_NAME, "harbor");
  assert.match(SIMKL_CLIENT_ID, /^[0-9a-f]{64}$/);
});
