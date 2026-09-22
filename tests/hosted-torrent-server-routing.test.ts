// Behavioral routing/fallback coverage for harborstremio/harbor#1156: a P2P
// addon url that points at a hosted torrent server must be routed to Harbor's
// engine first, while the addon url itself stays reachable when the engine
// declines or the user opted out.
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import { registerHooks } from "node:module";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { fileURLToPath } from "node:url";
import ts from "typescript";
import "./_localstorage-stub.ts";

// `resolve.ts` pulls modules that read `import.meta.env` at evaluation time
// (Vite-only). Node cannot evaluate those, so a synchronous load hook injects
// a test-mode `import.meta.env` before transpiling just those sources.
const SHIM = `import.meta.env ??= { DEV: false, PROD: true, MODE: "test", BASE_URL: "/" };\n`;

registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith("file://") && /[\\/]src[\\/].*\.tsx?$/.test(new URL(url).pathname)) {
      try {
        const source = readFileSync(fileURLToPath(url), "utf8");
        if (source.includes("import.meta.env")) {
          const output = ts.transpileModule(SHIM + source, {
            compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
          }).outputText;
          return { format: "module", source: output, shortCircuit: true };
        }
      } catch {
        // Fall through to the default loader when a source cannot be read.
      }
    }
    return nextLoad(url, context);
  },
});

const HASH = "0123456789abcdef0123456789abcdef01234567";
const HOSTED_URL = `https://streaming.strem.io/${HASH}/0`;
const ENGINE_STREAM_BASE = "http://127.0.0.1:11470/stream";
const ENGINE_URL = `${ENGINE_STREAM_BASE}/${HASH}/0`;
const SETTINGS_KEY = "harbor.settings";

type InvokeCall = { cmd: string; args: Record<string, unknown> };
const calls: InvokeCall[] = [];
let engineMode: "serve" | "decline" = "serve";

const scope = globalThis as { window?: Record<string, unknown> };
scope.window ??= globalThis as Record<string, unknown>;
scope.window.__TAURI_INTERNALS__ = {
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === "torrent_engine_add") {
      if (engineMode === "decline") throw new Error("engine unavailable");
      return {
        info_hash: HASH,
        files: [{ idx: 0, name: "Episode 1.mkv", length: 1_400_000_000 }],
        stream_base: ENGINE_STREAM_BASE,
        already_managed: true,
      };
    }
    if (cmd === "torrent_engine_select" || cmd === "torrent_engine_remove") return null;
    throw new Error(`unexpected engine command: ${cmd}`);
  },
};

const { resolveStream } = await import("../src/lib/streams/resolve.ts");
const { isHostedTorrentServerUrl } = await import("../src/lib/torrent/stremio-stream.ts");

function setSettings(value: Record<string, unknown> | null): void {
  if (value === null) localStorage.removeItem(SETTINGS_KEY);
  else localStorage.setItem(SETTINGS_KEY, JSON.stringify(value));
}

function reset(settings: Record<string, unknown> | null = null): void {
  calls.length = 0;
  engineMode = "serve";
  setSettings(settings);
}

function hostedStream(): Record<string, unknown> {
  return {
    infoHash: HASH,
    fileIdx: 0,
    url: HOSTED_URL,
    sources: [],
    cached: {},
    addonId: "test.addon",
    addonName: "Test Addon",
    addonUrl: "https://addon.example/stremio",
  };
}

function resolveHosted(stream: Record<string, unknown>, allowP2pFallback = true) {
  return resolveStream(
    stream as never,
    [],
    new AbortController().signal,
    true,
    false,
    undefined,
    allowP2pFallback,
    true,
  );
}

test("a hosted torrent-server url is routed to Harbor's engine first", async () => {
  reset();
  const r = await resolveHosted(hostedStream());
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.via, "p2p");
    assert.equal(r.data.url, ENGINE_URL);
  }
  assert.equal(calls[0]?.cmd, "torrent_engine_add", "the engine must be consulted first");
  assert.ok(
    calls.some((c) => c.cmd === "torrent_engine_select"),
    "the chosen engine file must be selected before playback",
  );
});

test("when the engine declines, the addon url stays playable with no engine failure code", async () => {
  reset();
  engineMode = "decline";
  const warn = console.warn;
  console.warn = () => {};
  let r;
  try {
    r = await resolveHosted(hostedStream());
  } finally {
    console.warn = warn;
  }
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.via, "direct");
    assert.equal(r.data.url, HOSTED_URL);
  }
});

test("a disabled P2P fallback never starts the local engine for a hosted URL", async () => {
  reset();
  const r = await resolveHosted(hostedStream(), false);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.via, "direct");
    assert.equal(r.data.url, HOSTED_URL);
  }
  assert.equal(calls.length, 0);
});

test("hosted URLs do not bypass an explicitly configured remote server with local P2P", async () => {
  reset({ remoteStreamServerUrl: "http://192.168.1.50:11470" });
  const r = await resolveHosted(hostedStream());
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.via, "direct");
    assert.equal(r.data.url, HOSTED_URL);
  }
  assert.equal(calls.length, 0);
});

test("ordinary direct urls never consult the engine", async () => {
  reset();
  const stream = { ...hostedStream(), url: "https://cdn.provider.example/video/ep1.mkv" };
  const r = await resolveHosted(stream);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.via, "direct");
    assert.equal(r.data.url, stream.url);
  }
  assert.equal(calls.length, 0, "a non-hosted url must not wake the torrent engine");
});

test("the global torrent opt-out keeps the hosted url path untouched", async () => {
  reset({ torrentsDisabled: true });
  const r = await resolveHosted(hostedStream());
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.via, "direct");
    assert.equal(r.data.url, HOSTED_URL);
  }
  assert.equal(calls.length, 0, "torrentsDisabled must suppress the engine attempt");
});

test("the direct-torrent opt-out never reaches the engine", async () => {
  reset({ directTorrentStream: false });
  const r = await resolveHosted(hostedStream());
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.via, "direct");
    assert.equal(r.data.url, HOSTED_URL);
  }
  assert.equal(calls.length, 0, "directTorrentStream:false must suppress the engine attempt");
});

test("a configured remote streaming server is respected, not hijacked", async () => {
  reset({ remoteStreamServerUrl: "http://192.168.1.50:11470" });
  const remoteUrl = `http://192.168.1.50:11470/${HASH}/2`;
  assert.equal(
    isHostedTorrentServerUrl(remoteUrl),
    false,
    "the user's own remote server is not a third-party hosted url",
  );
  const r = await resolveHosted({ ...hostedStream(), url: remoteUrl });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.via, "direct");
    assert.equal(r.data.url, remoteUrl, "the remote server url must be played as configured");
  }
  assert.equal(calls.length, 0, "a remote-served url must not be rerouted to the local engine");
});

test("without a remote server configured, a LAN torrent-server url is treated as hosted", async () => {
  reset();
  const lanUrl = `http://192.168.1.50:11470/${HASH}/2`;
  assert.equal(isHostedTorrentServerUrl(lanUrl), true);
  const r = await resolveHosted({ ...hostedStream(), url: lanUrl });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.via, "p2p", "an unowned torrent-server url routes through the engine");
});
