// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import {
  isLocalFileUrl,
  isSupportedSourceUrl,
  localFilePathFromUrl,
  readLocalTextFile,
  toLocalFileUrl,
  type LocalFileIo,
} from "../src/lib/iptv/local-file.ts";
import { detectProviderShape } from "../src/lib/iptv/ingest/detect.ts";
import { deriveEpgUrls, parseM3u } from "../src/lib/iptv/m3u.ts";
import {
  fetchAndParseXmltv,
  indexProgramsByChannel,
  localFileLogLabel,
  parseXmltv,
} from "../src/lib/iptv/xmltv.ts";
import type { IptvPlaylistSource } from "../src/lib/iptv/types.ts";

test("source validation accepts http(s) and resolvable absolute file:// only", () => {
  assert.equal(isSupportedSourceUrl("https://example.com/list.m3u"), true);
  assert.equal(isSupportedSourceUrl("http://example.com/list.m3u"), true);
  assert.equal(isSupportedSourceUrl("file:///C:/iptv/list.m3u"), true);
  assert.equal(isLocalFileUrl("  FILE:///C:/iptv/list.m3u  "), true);

  // Bare filesystem paths, other schemes, and scriptable URLs stay rejected so
  // local sources only ever come from the picker-produced file:// form.
  assert.equal(isSupportedSourceUrl("C:\\iptv\\list.m3u"), false);
  assert.equal(isSupportedSourceUrl("/home/me/list.m3u"), false);
  assert.equal(isSupportedSourceUrl("ftp://example.com/list.m3u"), false);
  assert.equal(isSupportedSourceUrl("javascript:alert(1)"), false);

  // Save-time validation uses the same resolver as the loader: every file://
  // form readLocalTextFile would refuse is refused here too, instead of being
  // saved only to fail on load.
  assert.equal(isSupportedSourceUrl("file://"), false);
  assert.equal(isSupportedSourceUrl("file://nas/list.m3u"), false);
  assert.equal(isSupportedSourceUrl("file://list.m3u"), false);
  assert.equal(isSupportedSourceUrl("file:///C:/bad%2.m3u"), false);

  // Picker-produced shapes (encoded Windows, POSIX, UNC) remain accepted.
  assert.equal(isSupportedSourceUrl("file:///C:/Users/Me/My%20List.m3u"), true);
  assert.equal(isSupportedSourceUrl("file:///home/me/guide.xml"), true);
  assert.equal(isSupportedSourceUrl("file:////nas/tv/list.m3u"), true);
});

test("file:// URLs round-trip picker paths on Windows, POSIX, and UNC", () => {
  const windows = toLocalFileUrl("C:\\Users\\Me\\My List.m3u");
  assert.equal(windows, "file:///C:/Users/Me/My%20List.m3u");
  assert.equal(localFilePathFromUrl(windows), "C:/Users/Me/My List.m3u");

  const posix = toLocalFileUrl("/home/me/playlist.m3u");
  assert.equal(posix, "file:///home/me/playlist.m3u");
  assert.equal(localFilePathFromUrl(posix), "/home/me/playlist.m3u");

  const unicode = toLocalFileUrl("C:\\TV\\Ünicode 频道.m3u");
  assert.equal(localFilePathFromUrl(unicode), "C:/TV/Ünicode 频道.m3u");

  const unc = toLocalFileUrl("\\\\nas\\tv\\list.m3u");
  assert.equal(localFilePathFromUrl(unc), "//nas/tv/list.m3u");

  // Idempotent for an already-encoded source URL.
  assert.equal(toLocalFileUrl(windows), windows);
});

test("localFilePathFromUrl rejects non-file, host-form, and relative references", () => {
  assert.equal(localFilePathFromUrl("https://example.com/list.m3u"), null);
  assert.equal(localFilePathFromUrl("file://"), null);
  // `file://host/path` names a host, not an absolute local path: refused.
  assert.equal(localFilePathFromUrl("file://nas/list.m3u"), null);
  assert.equal(localFilePathFromUrl("file://list.m3u"), null);
  // Malformed percent-encoding cannot be resolved to a path.
  assert.equal(localFilePathFromUrl("file:///C:/bad%2.m3u"), null);
});

function fakeIo(files: Record<string, string>): LocalFileIo & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async stat(path) {
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return { size: content.length, isFile: true };
    },
    async readTextFile(path) {
      reads.push(path);
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
  };
}

test("readLocalTextFile enforces the byte budget before and after reading", async () => {
  const playlist = "#EXTM3U\n#EXTINF:-1,Test\nhttp://example.com/one.m3u8\n";
  const io = fakeIo({ "C:/iptv/list.m3u": playlist });

  const text = await readLocalTextFile("file:///C:/iptv/list.m3u", 1024, io);
  assert.equal(text, playlist);
  assert.deepEqual(io.reads, ["C:/iptv/list.m3u"]);

  // Oversized file is rejected from stat alone: the body is never loaded.
  const big = fakeIo({ "C:/iptv/big.m3u": "x" });
  big.stat = async () => ({ size: 2 * 1024, isFile: true });
  await assert.rejects(readLocalTextFile("file:///C:/iptv/big.m3u", 1024, big), /too large/);
  assert.deepEqual(big.reads, []);

  // A racing growth between stat and read is caught by the post-read check.
  const grew = fakeIo({ "C:/iptv/grew.m3u": "x" });
  grew.stat = async () => ({ size: 1, isFile: true });
  grew.readTextFile = async () => "y".repeat(2048);
  await assert.rejects(readLocalTextFile("file:///C:/iptv/grew.m3u", 1024, grew), /too large/);

  // Empty and missing files fail with actionable errors.
  const empty = fakeIo({ "C:/iptv/empty.m3u": "" });
  await assert.rejects(readLocalTextFile("file:///C:/iptv/empty.m3u", 1024, empty), /empty/i);
  const missing = fakeIo({});
  await assert.rejects(
    readLocalTextFile("file:///C:/iptv/nope.m3u", 1024, missing),
    /missing or inaccessible/,
  );

  // Directories are refused before any read.
  const dir = fakeIo({ "C:/iptv": "" });
  dir.stat = async () => ({ size: 0, isFile: false });
  await assert.rejects(readLocalTextFile("file:///C:/iptv", 1024, dir), /not a regular file/);
});

test("readLocalTextFile refuses unresolvable URLs and non-desktop environments", async () => {
  await assert.rejects(
    readLocalTextFile("https://example.com/list.m3u", 1024),
    /not an absolute local file/,
  );
  await assert.rejects(readLocalTextFile("file://nas/list.m3u", 1024), /Browse/);
  // Node/browser-dev have no Tauri bridge: the default IO layer must refuse
  // instead of attempting any fallback read.
  await assert.rejects(readLocalTextFile("file:///C:/iptv/list.m3u", 1024), /desktop app/);
});

test("detectProviderShape routes picked local files and keeps URL behavior", () => {
  const localPlaylist: IptvPlaylistSource = {
    id: "pl-1",
    name: "Local",
    url: "file:///C:/iptv/list.m3u",
  };
  assert.deepEqual(detectProviderShape(localPlaylist), {
    kind: "m3u",
    url: "file:///C:/iptv/list.m3u",
    middleware: false,
    local: true,
  });

  const localEpg: IptvPlaylistSource = {
    id: "pl-2",
    name: "Local guide",
    url: "",
    kind: "epg",
    epgUrl: "file:///C:/iptv/guide.xml",
  };
  assert.deepEqual(detectProviderShape(localEpg), {
    kind: "epg",
    url: "file:///C:/iptv/guide.xml",
    local: true,
  });

  // A host-form or relative file:// reference is not a readable local path.
  const badLocal = detectProviderShape({ ...localPlaylist, url: "file://list.m3u" });
  assert.equal(badLocal.kind, "invalid");
  assert.match((badLocal as { reason: string }).reason, /Browse/);

  // Remote playlist URLs keep their exact previous shape.
  const remote = detectProviderShape({ ...localPlaylist, url: "https://example.com/list.m3u" });
  assert.deepEqual(remote, { kind: "m3u", url: "https://example.com/list.m3u", middleware: false });

  // Non-http schemes remain invalid, with guidance covering local files.
  const ftp = detectProviderShape({ ...localPlaylist, url: "ftp://example.com/list.m3u" });
  assert.equal(ftp.kind, "invalid");
  assert.match((ftp as { reason: string }).reason, /local file picked with Browse/);
});

test("local playlists derive no EPG; Xtream http URLs still do", () => {
  // Explicit policy: relative/derived references inside local files are never
  // followed — no url-tvg resolution, no path-derived guide endpoints.
  assert.deepEqual(deriveEpgUrls("file:///C:/iptv/list.m3u"), []);
  assert.deepEqual(deriveEpgUrls("C:/iptv/list.m3u"), []);

  const derived = deriveEpgUrls("https://prov.example:8080/get.php?username=u&password=p");
  assert.equal(derived.length, 2);
  assert.match(derived[0], /xmltv\.php\?/);
});

test("parseM3u preserves channel and url-tvg references exactly as written", () => {
  const playlist = [
    '#EXTM3U url-tvg="guide.xml"',
    '#EXTINF:-1 tvg-id="ch1" tvg-logo="logo.png",Channel One',
    "channels/one.m3u8",
    "",
  ].join("\n");
  const channels = parseM3u(playlist, "src");
  assert.equal(channels.length, 1);
  // Relative entries are handed to the player untouched; the app never
  // resolves them into file reads of its own.
  assert.equal(channels[0].url, "channels/one.m3u8");
  assert.equal(channels[0].logo, "logo.png");
});

test("fetchAndParseXmltv routes file:// sources to the local reader, not the network", async () => {
  await assert.rejects(fetchAndParseXmltv("file:///C:/iptv/guide.xml"), /desktop app/);
});

test("local XMLTV logs redact the directory but keep the file name and counts", async () => {
  const logs: string[] = [];
  const originalInfo = console.info;
  console.info = (...args: unknown[]): void => {
    logs.push(args.map(String).join(" "));
  };
  try {
    await assert.rejects(
      fetchAndParseXmltv("file:///C:/Users/Secret/Guide Dir/guide.xml"),
      /desktop app/,
    );
  } finally {
    console.info = originalInfo;
  }

  // The pre-read log carries no absolute path — only the file name.
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^\[epg\] read local file file:\/\/…\/guide\.xml$/);
  assert.ok(!logs[0].includes("Secret"), logs[0]);
  assert.ok(!logs[0].includes("Guide Dir"), logs[0]);

  // The post-parse log shares the same label and retains its diagnostics
  // (program/channel counts come from parseXmltv output around it).
  const label = localFileLogLabel("file:///home/me/secret/guide.xml");
  assert.equal(label, "file://…/guide.xml");
  const unc = localFileLogLabel("file:////nas/tv/guide.xml");
  assert.equal(unc, "file://…/guide.xml");
  // Unresolvable file:// forms leak nothing either.
  assert.equal(localFileLogLabel("file://nas/guide.xml"), "file://…");
  assert.equal(localFileLogLabel("https://example.com/guide.xml"), "file://…");
});

test("local XMLTV text parses into an indexed guide", () => {
  const xml = [
    "<tv>",
    '<channel id="c1"><display-name>Chan One</display-name></channel>',
    '<programme channel="c1" start="20260101120000 +0000" stop="20260101130000 +0000">',
    "<title>News</title></programme>",
    '<programme channel="c1" start="20260101130000 +0000" stop="20260101140000 +0000">',
    "<title>Movie</title></programme>",
    "</tv>",
  ].join("");
  const { programs, channelMeta } = parseXmltv(xml);
  assert.equal(programs.length, 2);
  assert.equal(channelMeta.get("c1")?.displayName, "Chan One");
  const index = indexProgramsByChannel(programs);
  assert.deepEqual(
    index.get("c1")?.map((p) => p.title),
    ["News", "Movie"],
  );
});
