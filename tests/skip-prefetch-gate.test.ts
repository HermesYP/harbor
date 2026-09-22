// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import { prefetchSkipSegments, skipPrefetchEnabled } from "../src/lib/skip-intro/prefetch.ts";

// harborstremio/harbor#1187: with every "Skip intros & credits" toggle off,
// hovering detail-page cards must not fire optional IntroDB/AniSkip requests.
const ALL_OFF = {
  showSkipButton: false,
  autoSkipIntro: false,
  autoSkipRecap: false,
  autoSkipOutro: false,
} as const;

test("skip prefetch is disabled when every skip feature is off", () => {
  assert.equal(skipPrefetchEnabled(ALL_OFF), false);
});

test("skip prefetch stays enabled while any skip feature is on", () => {
  for (const flag of [
    "showSkipButton",
    "autoSkipIntro",
    "autoSkipRecap",
    "autoSkipOutro",
  ] as const) {
    assert.equal(skipPrefetchEnabled({ ...ALL_OFF, [flag]: true }), true, flag);
  }
});

test("disabled prefetch never contacts segment providers", () => {
  const calls: string[] = [];
  prefetchSkipSegments(skipPrefetchEnabled(ALL_OFF), {
    aniskip: () => calls.push("aniskip"),
    introDb: () => calls.push("introDb"),
  });
  assert.deepEqual(calls, []);
});

test("enabled prefetch warms both providers exactly once", () => {
  const calls: string[] = [];
  prefetchSkipSegments(skipPrefetchEnabled({ ...ALL_OFF, showSkipButton: true }), {
    aniskip: () => calls.push("aniskip"),
    introDb: () => calls.push("introDb"),
  });
  assert.deepEqual(calls, ["aniskip", "introDb"]);
});

test("auto-skip toggles alone keep the warm-up alive", () => {
  for (const flag of ["autoSkipIntro", "autoSkipRecap", "autoSkipOutro"] as const) {
    const calls: string[] = [];
    prefetchSkipSegments(skipPrefetchEnabled({ ...ALL_OFF, [flag]: true }), {
      aniskip: () => calls.push("aniskip"),
      introDb: () => calls.push("introDb"),
    });
    assert.deepEqual(calls, ["aniskip", "introDb"], flag);
  }
});
