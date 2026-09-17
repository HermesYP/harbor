// @ts-nocheck -- Runs browser modules in an isolated Node test harness.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
function loadModule(path, dependencies, globals = {}) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  });
  const exports = {};
  vm.runInNewContext(outputText, {
    exports,
    require: (id) =>
      id === "@/lib/player/stall-wait"
        ? loadModule("../src/lib/player/stall-wait.ts", {})
        : id in dependencies
          ? dependencies[id]
          : require(id),
    ...globals,
  });
  return exports;
}

function retryHarness(t, overrides = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  let position = 0;
  let cursor = 0;
  const slots = [];
  const pending = [];
  const react = {
    useRef(value) {
      const i = cursor++;
      return (slots[i] ??= { current: value });
    },
    useState(value) {
      const ref = react.useRef(value);
      return [
        ref.current,
        (v) => {
          ref.current = v;
        },
      ];
    },
    useCallback(fn, deps) {
      const i = cursor++;
      const previous = slots[i];
      if (!previous || deps.some((v, n) => v !== previous.deps[n])) slots[i] = { deps, fn };
      return slots[i].fn;
    },
    useEffect(fn, deps) {
      const i = cursor++;
      const previous = slots[i];
      if (!previous || deps.some((v, n) => v !== previous.deps[n])) {
        pending.push(() => {
          previous?.cleanup?.();
          slots[i] = { deps, cleanup: fn() };
        });
      }
    },
  };
  const picks = [];
  const bridgeRef = { current: { destroy() {} } };
  const params = {
    bridgeRef,
    src: { url: "https://example.test/stream", meta: { id: "tt1" } },
    snap: { status: "loading", durationSec: 0, errorCode: null, videoWidth: 0, videoHeight: 0 },
    stremioServerTranscode: false,
    instantPlay: true,
    stallWaitSec: 30,
    autoNextStreamOnStall: true,
    inRoom: false,
    debrids: [],
    selfFrameReadyRef: { current: false },
    openPicker: (...args) => picks.push(args),
    engineFailure: false,
    isP2pEngine: false,
    engineStats: null,
    ...overrides,
  };
  const { useAutoRetry } = loadModule(
    "../src/views/player/hooks/use-auto-retry.ts",
    {
      react,
      "@/lib/player/playback-clock": {
        getPlaybackPosition: () => position,
        getPlaybackBuffered: () => 0,
        usePlaybackFlag: (fn) => fn(),
      },
      "@/lib/player/local-url": { isLocalUrl: (url) => url.startsWith("file:") },
      "@/lib/picker-cache": { clearOnePickerCache() {} },
      "@/lib/streams/resolve": {},
      "@/lib/stream-proxy": {},
      "@/lib/stremio-server": {},
      "@/lib/torrent/engine-stats": { GENUINE_FAILURE_WINDOW_MS: 15000 },
      "../player-utils": {
        BLACK_SCREEN_GRACE_MS: 6000,
        MAX_AUTORETRY_ATTEMPTS: 5,
        ROOM_STALL_MS: 9000,
        SLOW_LOAD_MS: 50000,
        STUCK_AUTORETRY_MS: 18000,
      },
    },
    { window: globalThis, Date, console: { warn() {} } },
  );
  function RenderStallUi(patch = {}) {
    Object.assign(params, patch);
    cursor = 0;
    useAutoRetry(params);
    pending.splice(0).forEach((run) => run());
  }
  RenderStallUi();
  return {
    params,
    picks,
    render: RenderStallUi,
    setPosition(value) {
      position = value;
    },
    unmount() {
      slots.forEach((s) => s?.cleanup?.());
    },
  };
}

function settingsHarness() {
  const storage = new Map();
  const theme = { DEFAULT_THEME: {}, FONT_PAIRS: {}, isKnownPreset: () => true };
  const defaults = loadModule("../src/lib/settings/defaults.ts", { "@/lib/theme": theme });
  const { loadStoredSettings } = loadModule(
    "../src/lib/settings/load.ts",
    {
      "./defaults": defaults,
      "@/lib/theme": theme,
      "@/lib/subtitles/language": { languageName: (v) => v },
      "@/lib/seek-step": { sanitizeSeekStep: (v, d) => v ?? d },
      "@/lib/ai-models": { migrateModelId: (v) => v },
      "@/lib/i18n": { resolveUiLanguage: () => "en" },
      "@/lib/poster-backdrop-expansion": { normalizePosterCardSettings: () => ({}) },
    },
    { localStorage: { getItem: (k) => storage.get(k) ?? null } },
  );
  return { storage, load: loadStoredSettings };
}

test("stored timeout defaults to the existing 18s and rejects invalid values", () => {
  const h = settingsHarness();
  assert.equal(h.load().stallWaitSec, 18);
  assert.equal(h.load().autoNextStreamOnStall, true);
  for (const value of [null, "30", -1, 0, 19, 999999, {}, []]) {
    h.storage.set("harbor.settings", JSON.stringify({ stallWaitSec: value }));
    assert.equal(h.load().stallWaitSec, 18);
  }
  for (const value of [18, 20, 30, 60]) {
    h.storage.set(
      "harbor.settings",
      JSON.stringify({ stallWaitSec: value, autoNextStreamOnStall: false }),
    );
    assert.equal(h.load().stallWaitSec, value);
    assert.equal(h.load().autoNextStreamOnStall, false);
  }
});

test("invalid runtime timeout falls back to 18 seconds", (t) => {
  const h = retryHarness(t, { stallWaitSec: -1 });
  t.mock.timers.tick(17999);
  assert.equal(h.picks.length, 0);
  t.mock.timers.tick(1);
  assert.equal(h.picks.length, 1);
  h.unmount();
});

test("settings UI changes the persisted timeout without enabling a disabled skip", () => {
  const h = settingsHarness();
  h.storage.set(
    "harbor.settings",
    JSON.stringify({ autoNextStreamOnStall: false, stallWaitSec: 30 }),
  );
  let settings = h.load();
  const { PlayModePanel } = loadModule("../src/views/settings/player-panel/play-mode-section.tsx", {
    "@/lib/settings": {
      useSettings: () => ({
        settings,
        update: (patch) => {
          settings = { ...settings, ...patch };
          h.storage.set("harbor.settings", JSON.stringify(settings));
        },
      }),
    },
    "@/lib/i18n": { useT: () => (s, vars) => (vars ? s.replace("{seconds}", vars.seconds) : s) },
    "../shared": { ToggleRow: () => null },
  });
  const elements = [];
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    elements.push(node);
    visit(node.props?.children);
  }
  visit(PlayModePanel());
  const select = elements.find((el) => el.type === "select" && el.props.id === "set-stall-wait");
  assert.ok(select, "timeout selector must be rendered in Play mode settings");
  assert.equal(select.props.value, 30);
  select.props.onChange({ target: { value: "60" } });
  assert.equal(h.load().stallWaitSec, 60);
  assert.equal(h.load().autoNextStreamOnStall, false);
  const playerSource = readFileSync(new URL("../src/views/player.tsx", import.meta.url), "utf8");
  assert.match(playerSource, /stallWaitSec: settings\.stallWaitSec/);
  assert.match(playerSource, /autoNextStreamOnStall: settings\.autoNextStreamOnStall/);
});

for (const status of ["playing", "paused"]) {
  test(`disabled skip also blocks ${status} watchdogs`, (t) => {
    const h = retryHarness(t, { autoNextStreamOnStall: false });
    h.render({ snap: { ...h.params.snap, status } });
    for (let i = 0; i < 130; i++) t.mock.timers.tick(1000);
    assert.equal(h.picks.length, 0);
    h.unmount();
  });
}

test("paused playback cancels a pending load timeout", (t) => {
  const h = retryHarness(t);
  t.mock.timers.tick(10000);
  h.render({ snap: { ...h.params.snap, status: "paused" } });
  t.mock.timers.tick(60000);
  assert.equal(h.picks.length, 0);
  h.unmount();
});

test("changing timeout cancels the old deadline and starts a fresh wait", (t) => {
  const h = retryHarness(t);
  t.mock.timers.tick(10000);
  h.render({ stallWaitSec: 60 });
  t.mock.timers.tick(59999);
  assert.equal(h.picks.length, 0);
  t.mock.timers.tick(1);
  assert.equal(h.picks.length, 1);
  h.unmount();
});

test("default room grace remains nine seconds", (t) => {
  const h = retryHarness(t, { inRoom: true, stallWaitSec: 18 });
  t.mock.timers.tick(8999);
  assert.equal(h.picks.length, 0);
  t.mock.timers.tick(1);
  assert.equal(h.picks.length, 1);
  h.unmount();
});

for (const seconds of [20, 60]) {
  test(`actual load watchdog uses ${seconds} seconds`, (t) => {
    const h = retryHarness(t, { stallWaitSec: seconds });
    t.mock.timers.tick(seconds * 1000 - 1);
    assert.equal(h.picks.length, 0);
    t.mock.timers.tick(1);
    assert.equal(h.picks.length, 1);
    t.mock.timers.tick(120000);
    assert.equal(h.picks.length, 1);
    h.unmount();
  });
}

for (const action of ["disable", "unmount", "progress", "ended"]) {
  test(`${action} cancels pending skip`, (t) => {
    const h = retryHarness(t);
    t.mock.timers.tick(10000);
    if (action === "disable") h.render({ autoNextStreamOnStall: false });
    if (action === "unmount") h.unmount();
    if (action === "progress") h.setPosition(2);
    if (action === "ended") h.render({ snap: { ...h.params.snap, status: "ended" } });
    t.mock.timers.tick(120000);
    assert.equal(h.picks.length, 0);
    h.unmount();
  });
}

test("source changes discard the old deadline", (t) => {
  const h = retryHarness(t);
  t.mock.timers.tick(10000);
  h.render({ src: { ...h.params.src, url: "https://example.test/second" } });
  t.mock.timers.tick(29999);
  assert.equal(h.picks.length, 0);
  t.mock.timers.tick(1);
  assert.equal(h.picks.length, 1);
  h.unmount();
});

test("room watchdog cannot bypass the configured wait", (t) => {
  const h = retryHarness(t, { inRoom: true });
  t.mock.timers.tick(29999);
  assert.equal(h.picks.length, 0);
  t.mock.timers.tick(1);
  assert.equal(h.picks.length, 1);
  h.unmount();
});

test("disabled stall skipping never advances an unstarted stream", (t) => {
  const h = retryHarness(t, { autoNextStreamOnStall: false });
  t.mock.timers.tick(120000);
  assert.equal(h.picks.length, 0);
  h.unmount();
});

test("actual load watchdog waits for the configured 30 seconds", (t) => {
  const h = retryHarness(t);
  t.mock.timers.tick(29999);
  assert.equal(h.picks.length, 0);
  t.mock.timers.tick(1);
  assert.equal(h.picks.length, 1);
  assert.equal(h.picks[0][2].autoPlay, true);
  h.unmount();
});
