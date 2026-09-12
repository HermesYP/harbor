// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";

test("deliberate failure to verify the required-check gate", () => {
  assert.equal(1, 2, "this failure is intentional");
});