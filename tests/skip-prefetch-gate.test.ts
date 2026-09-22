// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { readFileSync, readdirSync } from "node:fs";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import { prefetchSkipSegments, skipPrefetchEnabled } from "../src/lib/skip-intro/prefetch.ts";

// harborstremio/harbor#1187: hovering detail-page cards must not fire optional
// IntroDB/AniSkip requests. showSkipButton is UI visibility only — it defaults
// to true, so counting it would keep speculative prefetch alive for every
// default user and re-trigger the IntroDB Cloudflare popup.
type SkipFlags = {
  showSkipButton: boolean;
  autoSkipIntro: boolean;
  autoSkipRecap: boolean;
  autoSkipOutro: boolean;
};

const ALL_OFF: SkipFlags = {
  showSkipButton: false,
  autoSkipIntro: false,
  autoSkipRecap: false,
  autoSkipOutro: false,
};

const AUTO_SKIP_FLAGS = ["autoSkipIntro", "autoSkipRecap", "autoSkipOutro"] as const;

// Builds the gate input in a variable so showSkipButton can be present without
// becoming a fresh-literal excess property: SkipPrefetchSettings deliberately
// excludes it, and that exclusion is exactly what these tests lock down.
function gate(over: Partial<SkipFlags> = {}): boolean {
  const settings = { ...ALL_OFF, ...over };
  return skipPrefetchEnabled(settings);
}

// Read the shipped defaults (same pattern as poster-backdrop-expansion.test.ts;
// defaults.ts imports the @/ alias, which plain node cannot resolve).
function defaultSkipSettings(): SkipFlags {
  const source = readFileSync(
    new URL("../src/lib/settings/defaults.ts", import.meta.url),
    "utf8",
  );
  const read = (name: string): boolean => {
    const match = source.match(new RegExp(`\\b${name}: (true|false)`));
    assert.ok(match, `default for ${name} not found in defaults.ts`);
    return match[1] === "true";
  };
  return {
    showSkipButton: read("showSkipButton"),
    autoSkipIntro: read("autoSkipIntro"),
    autoSkipRecap: read("autoSkipRecap"),
    autoSkipOutro: read("autoSkipOutro"),
  };
}

test("shipped defaults do not permit speculative prefetch", () => {
  const defaults = defaultSkipSettings();
  // Document the coupling: showSkipButton being on by default is exactly why
  // it must stay out of the prefetch gate.
  assert.equal(defaults.showSkipButton, true);
  assert.equal(gate(defaults), false);
});

test("skip prefetch is disabled when every skip feature is off", () => {
  assert.equal(gate(), false);
});

test("showSkipButton alone never enables prefetch", () => {
  assert.equal(gate({ showSkipButton: true }), false);
});

test("skip prefetch stays enabled while any auto-skip feature is on", () => {
  for (const flag of AUTO_SKIP_FLAGS) {
    assert.equal(gate({ [flag]: true }), true, flag);
  }
});

test("disabled prefetch never contacts segment providers", () => {
  const calls: string[] = [];
  prefetchSkipSegments(gate(), {
    aniskip: () => calls.push("aniskip"),
    introDb: () => calls.push("introDb"),
  });
  assert.deepEqual(calls, []);
});

test("visible Skip button alone contacts no provider on hover", () => {
  const calls: string[] = [];
  prefetchSkipSegments(gate({ showSkipButton: true }), {
    aniskip: () => calls.push("aniskip"),
    introDb: () => calls.push("introDb"),
  });
  assert.deepEqual(calls, []);
});

test("enabled prefetch warms both providers exactly once", () => {
  const calls: string[] = [];
  prefetchSkipSegments(gate({ autoSkipIntro: true }), {
    aniskip: () => calls.push("aniskip"),
    introDb: () => calls.push("introDb"),
  });
  assert.deepEqual(calls, ["aniskip", "introDb"]);
});

test("auto-skip toggles alone keep the warm-up alive", () => {
  for (const flag of AUTO_SKIP_FLAGS) {
    const calls: string[] = [];
    prefetchSkipSegments(gate({ [flag]: true }), {
      aniskip: () => calls.push("aniskip"),
      introDb: () => calls.push("introDb"),
    });
    assert.deepEqual(calls, ["aniskip", "introDb"], flag);
  }
});

// Source-contract guard: the helper tests above cannot see an ungated
// prefetchSegments call, and one at any view call site would re-trigger the
// default-user popup. Assert every call site derives skipPrefetchOn from
// skipPrefetchEnabled(settings) and passes it as the gate argument, and that
// no other file under src/ calls prefetchSegments at all.
const PREFETCH_CALL_SITES = [
  "views/detail.tsx",
  "views/detail/episode-grid-card.tsx",
  "views/detail/series-episode-row.tsx",
  "views/play-picker.tsx",
];

const GATE_DERIVATION = /const\s+skipPrefetchOn\s*=\s*skipPrefetchEnabled\(settings\)/;
// Call sites never nest parens inside prefetchSegments arguments today; the
// lookbehind excludes the function definition in skip-intro/index.ts.
const PREFETCH_CALL = /(?<!function )prefetchSegments\(/g;
const GATED_CALL = /(?<!function )prefetchSegments\((?:[^;()])*?skipPrefetchOn\s*\)/g;

function readSrcFile(rel: string): string {
  return readFileSync(new URL(`../src/${rel}`, import.meta.url), "utf8");
}

test("every prefetch call site derives its gate from skipPrefetchEnabled", () => {
  for (const rel of PREFETCH_CALL_SITES) {
    const source = readSrcFile(rel);
    assert.match(source, GATE_DERIVATION, rel);
    const calls = source.match(PREFETCH_CALL) ?? [];
    assert.ok(calls.length > 0, `${rel} has no prefetchSegments call`);
    assert.equal((source.match(GATED_CALL) ?? []).length, calls.length, rel);
  }
});

test("no file outside the four call sites invokes prefetchSegments", () => {
  const root = new URL("../src/", import.meta.url);
  const callers = readdirSync(root, { recursive: true })
    .map((entry: string) => String(entry).replace(/\\/g, "/"))
    .filter((rel: string) => rel.endsWith(".ts") || rel.endsWith(".tsx"))
    .filter((rel: string) => readFileSync(new URL(rel, root), "utf8").match(PREFETCH_CALL));
  assert.deepEqual([...callers].sort(), [...PREFETCH_CALL_SITES].sort());
});
