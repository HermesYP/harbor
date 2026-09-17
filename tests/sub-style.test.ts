// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { applySubStyle } from "../src/lib/player/sub-style.ts";
import { nativeFontFamily, prepareMpvCustomFont } from "../src/lib/player/mpv-custom-font.ts";
import type { Settings } from "../src/lib/settings";

// A minimal SFNT name table: the display filename deliberately differs from its family.
function fontData(family: string): Uint8Array {
  const bytes = new Uint8Array(46 + family.length * 2);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x00010000);
  view.setUint16(4, 1);
  bytes.set(new TextEncoder().encode("name"), 12);
  view.setUint32(20, 28);
  view.setUint32(24, bytes.length - 28);
  view.setUint16(30, 1);
  view.setUint16(32, 18);
  view.setUint16(34, 3);
  view.setUint16(36, 1);
  view.setUint16(38, 0x0409);
  view.setUint16(40, 1);
  view.setUint16(42, family.length * 2);
  for (let i = 0; i < family.length; i++) view.setUint16(46 + i * 2, family.charCodeAt(i));
  return bytes;
}

function settingsFor(id: string, data = fontData("Actual Family")): Settings {
  return {
    subFontFamily: id,
    customFonts: [
      {
        id: "uploaded",
        name: "Misleading filename",
        format: "truetype",
        dataUrl: `data:font/ttf;base64,${btoa(String.fromCharCode(...data))}`,
      },
    ],
    subFontColor: "#ffffff",
    subBorderColor: "#000000",
    subBoxColor: "#000000",
    subAssOverride: "force",
  } as Settings;
}

test("reads Unicode family names from both TTF and OTF uploads", () => {
  const bytes = fontData("خط عربي");
  assert.equal(nativeFontFamily(bytes), "خط عربي");
  new DataView(bytes.buffer).setUint32(0, 0x4f54544f);
  assert.equal(nativeFontFamily(bytes), "خط عربي");
});

test("rejects truncated, malformed and unsupported web fonts", () => {
  assert.throws(() => nativeFontFamily(new Uint8Array(2)));
  assert.throws(() => nativeFontFamily(new TextEncoder().encode("wOF2invalid")));
  const bytes = fontData("Family");
  new DataView(bytes.buffer).setUint32(20, bytes.length + 100);
  assert.throws(() => nativeFontFamily(bytes));
});

test("does not prepare missing or path-like custom font ids", async () => {
  assert.equal(await prepareMpvCustomFont(settingsFor("custom:missing")), null);
  assert.equal(await prepareMpvCustomFont(settingsFor("custom:../../outside")), null);
});

test("resolves migrated uploads from IndexedDB and reuses the native cache", async () => {
  const originalWindow = globalThis.window;
  const originalIndexedDB = globalThis.indexedDB;
  globalThis.window = {} as Window & typeof globalThis;
  const settings = settingsFor("custom:uploaded");
  const dataUrl = settings.customFonts[0].dataUrl;
  delete settings.customFonts[0].dataUrl;
  const requestedIds: string[] = [];
  globalThis.indexedDB = {
    open() {
      const request = {
        result: {
          transaction() {
            return {
              objectStore: () => ({
                get(id: string) {
                  requestedIds.push(id);
                  const read = { result: dataUrl, onsuccess: () => {} };
                  queueMicrotask(() => read.onsuccess());
                  return read;
                },
              }),
            };
          },
        },
        onsuccess: () => {},
      };
      queueMicrotask(() => request.onsuccess());
      return request;
    },
  } as unknown as IDBFactory;
  const calls: string[] = [];
  mockIPC((command, args) => {
    calls.push(command);
    if (command === "plugin:path|resolve_directory") return "C:/cache";
    if (command === "plugin:path|join") return (args as { paths: string[] }).paths.join("/");
    if (command === "plugin:fs|exists") return true;
  });
  try {
    assert.deepEqual(await prepareMpvCustomFont(settings), {
      family: "Actual Family",
      directory: "C:/cache/subtitle-fonts/uploaded",
    });
    assert.deepEqual(requestedIds, ["uploaded"]);
    assert.ok(!calls.includes("plugin:fs|write_file"));
  } finally {
    clearMocks();
    globalThis.window = originalWindow;
    globalThis.indexedDB = originalIndexedDB;
  }
});

test("preserves every built-in family and falls back for missing uploads", async () => {
  const originalWindow = globalThis.window;
  globalThis.window = {} as Window & typeof globalThis;
  const selections: string[] = [];
  mockIPC((command, args) => {
    assert.equal(command, "mpv_set_property");
    const property = args as { name: string; value: string };
    if (property.name === "sub-font") selections.push(property.value);
  });
  try {
    for (const id of [
      "inter",
      "arabic",
      "system",
      "serif",
      "rounded",
      "custom:missing",
      "unknown",
    ]) {
      await applySubStyle(settingsFor(id));
    }
    assert.deepEqual(selections, [
      "Inter",
      "Noto Sans Arabic",
      "Segoe UI",
      "Times New Roman",
      "Segoe UI",
      "Inter",
      "Inter",
    ]);
  } finally {
    clearMocks();
    globalThis.window = originalWindow;
  }
});

test("does not let a slow upload overwrite a newer built-in selection", async () => {
  const originalWindow = globalThis.window;
  globalThis.window = {} as Window & typeof globalThis;
  let release: () => void = () => {};
  let started: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writing = new Promise<void>((resolve) => {
    started = resolve;
  });
  const selections: string[] = [];
  mockIPC(async (command, args) => {
    if (command === "plugin:path|resolve_directory") return "C:/cache";
    if (command === "plugin:path|join") return (args as { paths: string[] }).paths.join("/");
    if (command === "plugin:fs|write_file") {
      started();
      await pending;
    }
    if (command === "mpv_set_property" && (args as { name: string }).name === "sub-font")
      selections.push((args as { value: string }).value);
  });
  try {
    const first = applySubStyle(settingsFor("custom:uploaded"));
    await writing;
    await applySubStyle(settingsFor("serif"));
    release();
    await first;
    assert.deepEqual(selections, ["Times New Roman"]);
  } finally {
    release();
    clearMocks();
    globalThis.window = originalWindow;
  }
});

test("restores bundled fonts when switching back from an upload", async () => {
  const originalWindow = globalThis.window;
  globalThis.window = {} as Window & typeof globalThis;
  const directorySets: string[] = [];
  mockIPC((command, args) => {
    if (command === "mpv_get_property") return "C:/bundled/fonts";
    if (command === "plugin:path|resolve_directory") return "C:/cache";
    if (command === "plugin:path|join") return (args as { paths: string[] }).paths.join("/");
    if (command === "plugin:fs|read_dir") return [];
    if (command === "mpv_set_property" && (args as { name: string }).name === "sub-fonts-dir") {
      directorySets.push((args as { value: string }).value);
    }
  });
  try {
    await applySubStyle(settingsFor("custom:uploaded"));
    await applySubStyle(settingsFor("serif"));
    await applySubStyle(settingsFor("serif"));
    assert.deepEqual(directorySets, [
      "C:/cache/subtitle-fonts/uploaded",
      "C:/bundled/fonts",
      "C:/bundled/fonts",
    ]);
  } finally {
    clearMocks();
    globalThis.window = originalWindow;
  }
});

test("loads uploaded font bytes for mpv before selecting the real family", async () => {
  const originalWindow = globalThis.window;
  globalThis.window = {} as Window & typeof globalThis;
  const calls: Array<{ command: string; args: unknown }> = [];
  mockIPC((command, args) => {
    calls.push({ command, args });
    if (command === "mpv_get_property") return "C:/bundled/fonts";
    if (command === "plugin:path|resolve_directory") return "C:/cache";
    if (command === "plugin:path|join") return (args as { paths: string[] }).paths.join("/");
    if (command === "plugin:fs|read_dir") return [];
  });
  try {
    await applySubStyle(settingsFor("custom:uploaded"));
    const selected = calls.find(
      ({ command, args }) =>
        command === "mpv_set_property" && (args as { name: string }).name === "sub-font",
    );
    assert.deepEqual(selected?.args, { name: "sub-font", value: "Actual Family" });
    const written = calls.find(({ command }) => command === "plugin:fs|write_file");
    assert.deepEqual(written?.args, fontData("Actual Family"));
    const directoryIndex = calls.findIndex(
      ({ command, args }) =>
        command === "mpv_set_property" && (args as { name: string }).name === "sub-fonts-dir",
    );
    assert.ok(directoryIndex > calls.indexOf(written!));
    assert.ok(calls.indexOf(selected!) > directoryIndex);
  } finally {
    clearMocks();
    globalThis.window = originalWindow;
  }
});
