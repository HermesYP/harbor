// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { runInNewContext } from "node:vm";
import ts from "typescript";

type Providers = { wyzie: boolean; opensubtitles: boolean; jimaku: boolean; addons: boolean };
type StoredSettings = { subProvidersEnabled: Providers };

function loadModule<T>(path: string, deps: Record<string, unknown>, globals = {}): T {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {} as T;
  runInNewContext(output, {
    exports,
    require: (id: string) => {
      assert.ok(id in deps, `Unexpected dependency: ${id}`);
      return deps[id];
    },
    ...globals,
  });
  return exports;
}

// Load the production defaults and loader, not a replica of their merge logic.
const defaults = loadModule<{ DEFAULT: StoredSettings; STORAGE_KEY: string }>(
  "../src/lib/settings/defaults.ts",
  { "@/lib/theme": { DEFAULT_THEME: {} } },
);

function loader(raw: string | null, storageKey = defaults.STORAGE_KEY) {
  const reads: string[] = [];
  const module = loadModule<{ loadStoredSettings: (key?: string) => StoredSettings }>(
    "../src/lib/settings/load.ts",
    {
      "@/lib/theme": { DEFAULT_THEME: {}, FONT_PAIRS: {}, isKnownPreset: () => false },
      "@/lib/subtitles/language": { languageName: (value: string) => value },
      "@/lib/seek-step": {
        sanitizeSeekStep: (value: unknown, fallback: unknown) => value ?? fallback,
      },
      "@/lib/ai-models": { migrateModelId: (value: string) => value },
      "@/lib/i18n": { resolveUiLanguage: () => "en" },
      "@/lib/poster-backdrop-expansion": { normalizePosterCardSettings: () => ({}) },
      "./defaults": defaults,
    },
    {
      localStorage: {
        getItem(key: string) {
          reads.push(key);
          return key === storageKey ? raw : null;
        },
      },
    },
  );
  return {
    reads,
    load(key?: string): Providers {
      return JSON.parse(JSON.stringify(module.loadStoredSettings(key).subProvidersEnabled));
    },
  };
}

for (const enabled of [false, true]) {
  test(`settings loader preserves persisted OpenSubtitles ${enabled} on repeated loads`, () => {
    const settings = loader(JSON.stringify({ subProvidersEnabled: { opensubtitles: enabled } }));
    for (let i = 0; i < 2; i++) {
      assert.deepEqual(settings.load(), {
        wyzie: false,
        opensubtitles: enabled,
        jimaku: false,
        addons: true,
      });
    }
    assert.equal(settings.reads[0], defaults.STORAGE_KEY);
  });
}

for (const raw of [
  null,
  "{}",
  '{"subProvidersEnabled":{}}',
  '{"subProvidersEnabled":null}',
  "invalid json",
]) {
  test(`settings loader retains provider defaults for ${raw ?? "absent storage"}`, () => {
    assert.deepEqual(loader(raw).load(), {
      wyzie: false,
      opensubtitles: true,
      jimaku: false,
      addons: true,
    });
  });
}

test("loading an alternate settings key preserves OpenSubtitles and existing provider policy", () => {
  const key = "harbor.settings.test-profile";
  const settings = loader(
    JSON.stringify({
      subProvidersEnabled: { wyzie: true, opensubtitles: false, jimaku: true, addons: false },
    }),
    key,
  );
  assert.deepEqual(settings.load(key), {
    wyzie: false,
    opensubtitles: false,
    jimaku: true,
    addons: false,
  });
  assert.equal(settings.reads[0], key);
});
