// @ts-nocheck -- Node test modules are outside the browser-only TypeScript config.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import { compileMpvOptions, mergeMpvOptions } from "../src/lib/player/mpv-tuning.ts";
import type { Settings } from "../src/lib/settings/types.ts";

const require = createRequire(import.meta.url);
// Exercise the real settings loader/store and panel without browser-only dependencies.
function loadModule(path: string, imports: Record<string, unknown>) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  });
  const exports: Record<string, any> = {};
  new Function("require", "exports", outputText)((id: string) => {
    if (id in imports) return imports[id];
    if (id === "react/jsx-runtime") return require(id);
    throw new Error(`Unexpected import: ${id}`);
  }, exports);
  return exports;
}

function settingsHarness() {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  const theme = { DEFAULT_THEME: {}, FONT_PAIRS: [], isKnownPreset: () => false };
  const defaults = loadModule("../src/lib/settings/defaults.ts", { "@/lib/theme": theme });
  const load = loadModule("../src/lib/settings/load.ts", {
    "@/lib/theme": theme,
    "@/lib/subtitles/language": { languageName: () => "English" },
    "@/lib/seek-step": { sanitizeSeekStep: (_v: unknown, fallback: number) => fallback },
    "@/lib/ai-models": { migrateModelId: (v: unknown) => v },
    "@/lib/i18n": { resolveUiLanguage: () => "en" },
    "@/lib/poster-backdrop-expansion": { normalizePosterCardSettings: () => ({}) },
    "./defaults": defaults,
  });
  const store = loadModule("../src/lib/settings/profile-store.ts", { "./load": load });
  return { values, defaults, load, store };
}

test("saved buffer selection survives reload and legacy boost migrates", () => {
  const { values, defaults, load, store } = settingsHarness();
  assert.equal(defaults.DEFAULT.mpvBufferSize, "auto");
  values.set("legacy", JSON.stringify({ mpvBufferBoost: true }));
  assert.equal(load.loadStoredSettings("legacy").mpvBufferSize, "large");
  values.set("legacy", JSON.stringify({ mpvBufferBoost: false }));
  assert.equal(load.loadStoredSettings("legacy").mpvBufferSize, "auto");
  for (const mpvBufferSize of ["auto", "small", "large"]) {
    const selected = { ...defaults.DEFAULT, mpvBufferBoost: true, mpvBufferSize };
    const json = store.persistEffective(selected, "test-profile", false);
    assert.equal(JSON.parse(json).mpvBufferSize, mpvBufferSize);
    assert.equal(store.loadEffective("test-profile", false).mpvBufferSize, mpvBufferSize);
  }
  values.set("invalid", JSON.stringify({ mpvBufferSize: "unlimited" }));
  assert.equal(load.loadStoredSettings("invalid").mpvBufferSize, "auto");
});

test("auto leaves native live/VOD defaults intact and explicit large sets all limits", () => {
  const { defaults } = settingsHarness();
  const auto = { ...defaults.DEFAULT, mpvBufferBoost: true, mpvBufferSize: "auto" } as Settings;
  assert.equal(compileMpvOptions(auto), "");
  const large = compileMpvOptions({ ...auto, mpvBufferSize: "large" }).split("\n");
  for (const line of [
    "demuxer-max-bytes=1GiB",
    "demuxer-max-back-bytes=128MiB",
    "demuxer-readahead-secs=600",
    "stream-buffer-size=64MiB",
    "cache-secs=600",
  ]) {
    assert.ok(large.includes(line), line);
  }
});

test("buffer control saves a selection that reaches the native options", () => {
  const { defaults, store } = settingsHarness();
  let settings = defaults.DEFAULT;
  const Segmented = () => null;
  const panel = loadModule("../src/views/settings/mpv-panel.tsx", {
    "@/lib/settings": {
      useSettings: () => ({
        settings,
        update: (patch: Partial<Settings>) => {
          settings = { ...settings, ...patch };
        },
      }),
    },
    "@/lib/i18n": { useT: () => (text: string) => text },
    "./shared": { Section: () => null, Segmented, ToggleRow: () => null },
    "./player-panel/internals": { isTauri: true },
    "./mpv-panel/profile": { QualityProfile: () => null },
    "./mpv-panel/dials": { PictureDialsSection: () => null, ColorHdrSection: () => null },
    "./mpv-panel/advanced": { AdvancedMpvSection: () => null },
  });
  function descendants(node: any): any[] {
    if (!node || typeof node !== "object") return [];
    return [node, ...[node.props?.children].flat().flatMap(descendants)];
  }
  const control = descendants(panel.MpvPanel()).find(
    (node) =>
      node.type === Segmented && node.props.options.some((option: any) => option.value === "small"),
  );
  assert.ok(control, "buffer size selector must be visible");
  assert.equal(control.props.value, "auto");
  control.props.onChange("small");
  store.persistEffective(settings, "test-profile", false);
  const restored = store.loadEffective("test-profile", false);
  assert.equal(restored.mpvBufferSize, "small");
  assert.match(mergeMpvOptions(restored, false)!, /demuxer-max-bytes=128MiB/);
});

test("mpv bridge forwards selected limits on both live and VOD startup", async () => {
  const { defaults } = settingsHarness();
  const calls: Array<{ command: string; payload: any }> = [];
  const native = loadModule("../src/lib/player/mpv.ts", {
    "@tauri-apps/api/core": {
      invoke: async (command: string, payload: any) => {
        calls.push({ command, payload });
      },
    },
    "@tauri-apps/api/event": { listen: async () => () => {} },
    "./subtitle-load": { subtitleDownloadArgs: () => ({}) },
    "./mpv-failure": { mpvFailureSnapshot: () => ({}) },
    "@/lib/platform": {
      isLinuxDesktop: () => false,
      isMacDesktop: () => false,
      isWindowsDesktop: () => true,
    },
    "@/lib/tauri-unlisten": { makeSafeTauriUnlisten: (fn: unknown) => fn },
    "./bridge": { emptySnapshot: {} },
  });
  const extraOptions = mergeMpvOptions({ ...defaults.DEFAULT, mpvBufferSize: "small" }, false);
  for (const isLive of [false, true]) {
    const bridge = native.createMpvBridge({ anime4k: false, hdrToSdr: false, extraOptions });
    await bridge.load({ url: "https://example.test/video", isLive });
    const start = calls.at(-1);
    assert.equal(start?.command, "mpv_start");
    assert.equal(start?.payload.args.isLive, isLive);
    assert.equal(start?.payload.args.extraOptions, extraOptions);
  }
  const rust = readFileSync(new URL("../src-tauri/src/mpv.rs", import.meta.url), "utf8");
  const start = rust.slice(rust.indexOf("pub async fn mpv_start("));
  assert.ok(
    start.indexOf("apply_extra_mpv_options(&mpv, extra)") >
      start.indexOf('mpv.set_property("stream-buffer-size", "32MiB")'),
  );
  assert.ok(
    start.indexOf("apply_extra_mpv_options(&mpv, extra)") < start.indexOf('vec!["loadfile"'),
  );
});

test(
  "real libmpv accepts and reports the selected buffer limits",
  {
    skip:
      !process.env.HARBOR_TEST_LIBMPV && "Set HARBOR_TEST_LIBMPV to a libmpv DLL/shared library",
  },
  () => {
    const { defaults } = settingsHarness();
    const options = ["small", "large"].map((mpvBufferSize) =>
      compileMpvOptions({ ...defaults.DEFAULT, mpvBufferSize }),
    );
    const probe = spawnSync(
      process.env.HARBOR_TEST_PYTHON ?? "python",
      [
        fileURLToPath(new URL("./helpers/mpv-buffer-probe.py", import.meta.url)),
        process.env.HARBOR_TEST_LIBMPV!,
      ],
      { input: JSON.stringify(options), encoding: "utf8", timeout: 30000 },
    );
    assert.equal(probe.status, 0, `${probe.error ?? ""}\n${probe.stderr}`);
    assert.deepEqual(JSON.parse(probe.stdout), [
      {
        "demuxer-max-bytes": 128 * 1048576,
        "demuxer-max-back-bytes": 32 * 1048576,
        "demuxer-readahead-secs": 60,
        "stream-buffer-size": 8 * 1048576,
        "cache-secs": 60,
      },
      {
        "demuxer-max-bytes": 1024 * 1048576,
        "demuxer-max-back-bytes": 128 * 1048576,
        "demuxer-readahead-secs": 600,
        "stream-buffer-size": 64 * 1048576,
        "cache-secs": 600,
      },
    ]);
  },
);

test("advanced buffer overrides remain last in the options sent to native mpv", () => {
  const { defaults } = settingsHarness();
  const options = mergeMpvOptions(
    {
      ...defaults.DEFAULT,
      mpvBufferSize: "small",
      mpvTweaks: { "demuxer-max-bytes": "256MiB" },
      mpvExtraOptions: "demuxer-max-bytes=2GiB",
    },
    false,
  )!;
  const limits = options.split("\n").filter((line) => line.startsWith("demuxer-max-bytes="));
  assert.deepEqual(limits, [
    "demuxer-max-bytes=128MiB",
    "demuxer-max-bytes=256MiB",
    "demuxer-max-bytes=2GiB",
  ]);
});
