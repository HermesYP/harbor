// Regression coverage for the hosted torrent index regression reviewed under
// HermesYP/harbor#23 (the hosted torrent-server routing guardrail from
// harborstremio/harbor#1156). A stream like
//   { infoHash: H, url: "https://streaming.strem.io/H/2" }
// without a fileIdx must keep the index the addon URL names: addon parsing
// inherits it (so completed-download/debrid paths share it too), and the local
// engine must not guess episode/largest when the URL still carries it. Only
// hosted torrent-server URLs follow the /<hash>/<idx> contract — arbitrary
// URLs (proxy links etc.), hash mismatches, invalid indexes, and indexes the
// engine's file list does not actually contain are never trusted and fall
// back to the previous guess behavior.
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

// `resolve.ts`/`addons.ts` pull modules that read `import.meta.env` at
// evaluation time (Vite-only). Node cannot evaluate those, so a synchronous
// load hook injects a test-mode `import.meta.env` before transpiling them.
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
const OTHER_HASH = "89abcdef0123456789abcdef0123456789abcdef";
const ENGINE_STREAM_BASE = "http://127.0.0.1:11470/stream";
const SETTINGS_KEY = "harbor.settings";

// A multipart torrent: idx 1 is the largest file, so the episode/largest guess
// (no season/episode hint available) resolves to idx 1. The addon URL names
// idx 2, which only an inherited index can reach.
const ENGINE_FILES = [
  { idx: 0, name: "Show.S01E01.mkv", length: 2_000_000_000 },
  { idx: 1, name: "Show.S01E02.mkv", length: 2_400_000_000 },
  { idx: 2, name: "Show.S01E03.mkv", length: 1_800_000_000 },
];
const GUESSED_IDX = 1;
const PROXY_URL = "https://api.addon.example/proxy";

// Sparse idx list: 7 files where idx 5 does not exist. A naive
// `idx < files.length` check would wrongly accept 5; membership by idx must not.
const SPARSE_ENGINE_FILES = [
  { idx: 0, name: "Show.S01E01.mkv", length: 1_000_000_000 },
  { idx: 1, name: "Show.S01E02.mkv", length: 1_100_000_000 },
  { idx: 2, name: "Show.S01E03.mkv", length: 1_200_000_000 },
  { idx: 3, name: "Show.S01E04.mkv", length: 1_300_000_000 },
  { idx: 4, name: "Show.S01E05.mkv", length: 1_400_000_000 },
  { idx: 6, name: "Show.S01E07.mkv", length: 9_000_000_000 },
  { idx: 7, name: "Show.S01E08.mkv", length: 1_500_000_000 },
];
const SPARSE_GUESSED_IDX = 6; // largest file when no hint matches

type InvokeCall = { cmd: string; args: Record<string, unknown> };
const calls: InvokeCall[] = [];
let addonPayload: Array<Record<string, unknown>> = [];
let engineFiles = ENGINE_FILES;

const scope = globalThis as { window?: Record<string, unknown> };
scope.window ??= globalThis as Record<string, unknown>;
scope.window.__TAURI_INTERNALS__ = {
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === "torrent_engine_add") {
      return {
        info_hash: HASH,
        files: engineFiles,
        stream_base: ENGINE_STREAM_BASE,
        already_managed: true,
      };
    }
    if (cmd === "torrent_engine_select" || cmd === "torrent_engine_remove") return null;
    if (cmd === "harbor_fetch") {
      return {
        status: 200,
        ok: true,
        body: JSON.stringify({ streams: addonPayload }),
        contentType: "application/json",
      };
    }
    throw new Error(`unexpected engine command: ${cmd}`);
  },
};

const { resolveStream } = await import("../src/lib/streams/resolve.ts");
const { fetchAddonStreams } = await import("../src/lib/streams/addons.ts");
const { fileIdxFromUrlForHash } = await import("../src/lib/torrent/magnet.ts");

const ADDON = {
  transportUrl: "https://addon.example.test/manifest.json",
  manifest: {
    id: "test.addon",
    name: "Test Addon",
    resources: ["stream"],
    types: ["series"],
    idPrefixes: ["tt"],
  },
};

function setSettings(value: Record<string, unknown> | null): void {
  if (value === null) localStorage.removeItem(SETTINGS_KEY);
  else localStorage.setItem(SETTINGS_KEY, JSON.stringify(value));
}

function reset(): void {
  calls.length = 0;
  engineFiles = ENGINE_FILES;
  setSettings(null);
}

function hostedStream(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    infoHash: HASH,
    url: `https://streaming.strem.io/${HASH}/2`,
    sources: [],
    cached: {},
    addonId: "test.addon",
    addonName: "Test Addon",
    addonUrl: "https://addon.example/stremio",
    ...overrides,
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

function invokeArgs(cmd: string): Record<string, unknown> | undefined {
  return calls.find((c) => c.cmd === cmd)?.args;
}

// Each mapping call is its own fetch response so dedupe (hash+fileIdx keys
// within one addon) cannot collapse the fileIdx-less cases together.
async function fetchMapped(streams: Array<Record<string, unknown>>) {
  addonPayload = streams;
  return await fetchAddonStreams(
    [ADDON as never],
    { type: "series", ids: ["tt123"] },
    new AbortController().signal,
    undefined,
    undefined,
    1000,
  );
}

test("fileIdxFromUrlForHash inherits only a matching hash with a safe non-negative index", () => {
  assert.equal(fileIdxFromUrlForHash(`https://streaming.strem.io/${HASH}/2`, HASH), 2);
  assert.equal(
    fileIdxFromUrlForHash(`https://streaming.strem.io/${HASH}/2`, HASH.toUpperCase()),
    2,
    "hash comparison must be case-insensitive",
  );
  assert.equal(
    fileIdxFromUrlForHash(`https://streaming.strem.io/${OTHER_HASH}/2`, HASH),
    undefined,
    "a foreign hash must not be trusted",
  );
  assert.equal(
    fileIdxFromUrlForHash(`https://streaming.strem.io/${HASH}/-1`, HASH),
    undefined,
    "stremio's -1 (auto) carries no intended index",
  );
  assert.equal(
    fileIdxFromUrlForHash(`https://streaming.strem.io/${HASH}/99999999999999999999999`, HASH),
    undefined,
    "an unsafe integer index must not be trusted",
  );
  assert.equal(fileIdxFromUrlForHash(`https://streaming.strem.io/${HASH}/`, HASH), undefined);
  assert.equal(fileIdxFromUrlForHash(undefined, HASH), undefined);
  assert.equal(fileIdxFromUrlForHash(`https://streaming.strem.io/${HASH}/2`, null), undefined);
});

test("addon parsing inherits the hosted URL's index when the addon already sent the hash", async () => {
  reset();
  const streams = await fetchMapped([
    { infoHash: HASH, url: `https://streaming.strem.io/${HASH}/2`, name: "Show S01E03" },
  ]);
  assert.equal(streams.length, 1);
  assert.equal(streams[0].infoHash, HASH);
  assert.equal(
    streams[0].fileIdx,
    2,
    "the reported regression: a provided infoHash must not skip URL index extraction",
  );
});

test("addon parsing never overrides an explicit fileIdx with the URL's index", async () => {
  reset();
  const streams = await fetchMapped([
    {
      infoHash: HASH,
      url: `https://streaming.strem.io/${HASH}/2`,
      fileIdx: 0,
      name: "Show S01E01",
    },
  ]);
  assert.equal(streams[0].fileIdx, 0, "an explicit fileIdx must win over the URL");
});

test("addon parsing rejects a URL whose hash does not match the stream's infoHash", async () => {
  reset();
  const streams = await fetchMapped([
    { infoHash: HASH, url: `https://streaming.strem.io/${OTHER_HASH}/2`, name: "Mismatch" },
  ]);
  assert.equal(streams[0].infoHash, HASH, "the addon's own hash stays authoritative");
  assert.equal(streams[0].fileIdx, undefined, "a mismatched URL hash must not donate an index");
});

test("addon parsing rejects invalid URL indexes (-1 and missing)", async () => {
  reset();
  const minusOne = await fetchMapped([
    { infoHash: HASH, url: `https://streaming.strem.io/${HASH}/-1`, name: "Auto" },
  ]);
  assert.equal(minusOne[0].fileIdx, undefined, "-1 means auto, not file -1");
  const noIndex = await fetchMapped([
    { infoHash: HASH, url: `https://streaming.strem.io/${HASH}/`, name: "No index" },
  ]);
  assert.equal(noIndex[0].fileIdx, undefined, "a URL without an index donates nothing");
});

test("the legacy uncached derivation still fills hash and index together", async () => {
  reset();
  const streams = await fetchMapped([
    { url: `https://streaming.strem.io/${HASH}/3`, name: "⚠ uncached" },
  ]);
  assert.equal(streams[0].infoHash, HASH, "hash derivation from the URL is unchanged");
  assert.equal(streams[0].fileIdx, 3, "the derived hash still carries its URL index");
});

test("addon parsing never inherits an index from a non-hosted URL", async () => {
  reset();
  const streams = await fetchMapped([
    { infoHash: HASH, url: `${PROXY_URL}/${HASH}/2`, name: "Proxy" },
  ]);
  assert.equal(streams[0].infoHash, HASH, "the addon's own hash is unaffected");
  assert.equal(
    streams[0].fileIdx,
    undefined,
    "a proxy URL's /<hash>/<idx> path is not the torrent-server contract (P1)",
  );
});

test("legacy uncached hash derivation keeps the hash but not a non-hosted URL's index", async () => {
  reset();
  const streams = await fetchMapped([
    { url: `${PROXY_URL}/${HASH}/3`, name: "⚠ uncached" },
  ]);
  assert.equal(streams[0].infoHash, HASH, "the legacy hash derivation is preserved");
  assert.equal(streams[0].fileIdx, undefined, "but a non-hosted URL must not donate its index");
});

test("a missing fileIdx inherits the hosted URL's index instead of the largest-file guess", async () => {
  reset();
  const r = await resolveHosted(hostedStream());
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.via, "p2p");
    assert.equal(
      r.data.url,
      `${ENGINE_STREAM_BASE}/${HASH}/2`,
      "the engine URL must point at the file the addon URL named",
    );
    assert.equal(r.data.fileIdx, 2);
  }
  assert.equal(
    invokeArgs("torrent_engine_add")?.fileIdx,
    2,
    "the engine must be told the intended file up front",
  );
  assert.equal(
    invokeArgs("torrent_engine_select")?.fileIdx,
    2,
    "multipart torrents must not fall back to the episode/largest guess",
  );
});

test("an explicit fileIdx still wins over the hosted URL's index", async () => {
  reset();
  const r = await resolveHosted(hostedStream({ fileIdx: 1 }));
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.data.url, `${ENGINE_STREAM_BASE}/${HASH}/1`);
  assert.equal(invokeArgs("torrent_engine_add")?.fileIdx, 1);
  assert.equal(invokeArgs("torrent_engine_select")?.fileIdx, 1);
});

test("a mismatched URL hash falls back to the previous episode/largest guess", async () => {
  reset();
  const r = await resolveHosted(
    hostedStream({ url: `https://streaming.strem.io/${OTHER_HASH}/2` }),
  );
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.via, "p2p");
    assert.equal(r.data.url, `${ENGINE_STREAM_BASE}/${HASH}/${GUESSED_IDX}`);
  }
  assert.equal(
    invokeArgs("torrent_engine_add")?.fileIdx,
    null,
    "a foreign hash must not pick the file",
  );
  assert.equal(invokeArgs("torrent_engine_select")?.fileIdx, GUESSED_IDX);
});

test("an invalid URL index (-1) falls back to the guess instead of garbage", async () => {
  reset();
  const r = await resolveHosted(hostedStream({ url: `https://streaming.strem.io/${HASH}/-1` }));
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.data.url, `${ENGINE_STREAM_BASE}/${HASH}/${GUESSED_IDX}`);
  assert.equal(invokeArgs("torrent_engine_add")?.fileIdx, null);
  assert.equal(invokeArgs("torrent_engine_select")?.fileIdx, GUESSED_IDX);
});

test("a non-hosted URL never picks the file: the episode hint wins (P1)", async () => {
  reset();
  // forceP2p sends any infoHash stream through the engine regardless of URL
  // class, so this exercises the resolve-level inheritance gate directly.
  const r = await resolveStream(
    hostedStream({ url: `${PROXY_URL}/${HASH}/2` }) as never,
    [],
    new AbortController().signal,
    true,
    true,
    { season: 1, episode: 2 },
    true,
    true,
  );
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.via, "p2p");
    assert.equal(
      r.data.url,
      `${ENGINE_STREAM_BASE}/${HASH}/1`,
      "the hint (S01E02 → idx 1), not the proxy URL's trailing /2, must choose the file",
    );
  }
  assert.equal(
    invokeArgs("torrent_engine_add")?.fileIdx,
    null,
    "a non-hosted URL must not donate an index",
  );
  assert.equal(invokeArgs("torrent_engine_select")?.fileIdx, 1, "episode hint match expected");
});

test("a hosted URL index the torrent does not contain falls back to the guess (P2)", async () => {
  reset();
  const r = await resolveHosted(hostedStream({ url: `https://streaming.strem.io/${HASH}/4` }));
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.via, "p2p");
    assert.equal(
      r.data.url,
      `${ENGINE_STREAM_BASE}/${HASH}/${GUESSED_IDX}`,
      "idx 4 does not exist in a 3-file torrent; the guess must win",
    );
  }
  assert.equal(invokeArgs("torrent_engine_add")?.fileIdx, 4, "the intended index is still passed");
  assert.equal(invokeArgs("torrent_engine_select")?.fileIdx, GUESSED_IDX);
});

test("file existence is checked by idx membership, not by file count (sparse idx)", async () => {
  reset();
  engineFiles = SPARSE_ENGINE_FILES;
  // idx 5 is absent while files.length is 7, so `5 < files.length` would pass
  // a naive bound check — only membership by idx rejects it.
  const r = await resolveHosted(hostedStream({ url: `https://streaming.strem.io/${HASH}/5` }));
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.via, "p2p");
    assert.equal(r.data.url, `${ENGINE_STREAM_BASE}/${HASH}/${SPARSE_GUESSED_IDX}`);
  }
  assert.equal(invokeArgs("torrent_engine_add")?.fileIdx, 5);
  assert.equal(
    invokeArgs("torrent_engine_select")?.fileIdx,
    SPARSE_GUESSED_IDX,
    "a missing sparse idx must fall back to the guess, not be selected",
  );

  // A sparse idx that does exist must still be selectable.
  calls.length = 0;
  const ok = await resolveHosted(hostedStream({ url: `https://streaming.strem.io/${HASH}/7` }));
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.data.url, `${ENGINE_STREAM_BASE}/${HASH}/7`);
  assert.equal(invokeArgs("torrent_engine_select")?.fileIdx, 7);
});

test("parsing → resolve end to end: an inherited out-of-range idx still guesses (P2)", async () => {
  reset();
  // The hole parse-time normalization creates: fetchOne maps the hosted URL's
  // idx 4 into stream.fileIdx, so resolve must not mistake it for an explicit
  // addon-provided fileIdx and select a file this 3-file torrent does not have.
  const [mapped] = await fetchMapped([
    { infoHash: HASH, url: `https://streaming.strem.io/${HASH}/4`, name: "Show S01E04" },
  ]);
  assert.equal(mapped.fileIdx, 4, "parsing inherits the hosted index");
  const r = await resolveHosted(mapped as unknown as Record<string, unknown>);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.via, "p2p");
    assert.equal(
      r.data.url,
      `${ENGINE_STREAM_BASE}/${HASH}/${GUESSED_IDX}`,
      "idx 4 does not exist; the mapped index must still be verified against the file list",
    );
    assert.equal(r.data.fileIdx, GUESSED_IDX);
  }
  assert.equal(invokeArgs("torrent_engine_add")?.fileIdx, 4, "the intended index is still passed");
  assert.equal(invokeArgs("torrent_engine_select")?.fileIdx, GUESSED_IDX);

  // In range, the mapped index is honored end to end.
  calls.length = 0;
  const [mappedInRange] = await fetchMapped([
    { infoHash: HASH, url: `https://streaming.strem.io/${HASH}/2`, name: "Show S01E03" },
  ]);
  assert.equal(mappedInRange.fileIdx, 2);
  const ok = await resolveHosted(mappedInRange as unknown as Record<string, unknown>);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.data.url, `${ENGINE_STREAM_BASE}/${HASH}/2`);
  assert.equal(invokeArgs("torrent_engine_select")?.fileIdx, 2);
});
