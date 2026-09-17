// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { registerHooks } from "node:module";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mockIPC } from "@tauri-apps/api/mocks";
import { load } from "cheerio";

// Compile the real component, including its real external store, without a second test implementation.
registerHooks({
  resolve(
    specifier: string,
    context: unknown,
    nextResolve: (specifier: string, context: unknown) => unknown,
  ) {
    if (specifier.startsWith("@/")) {
      return {
        url: new URL(`../src/${specifier.slice(2)}.ts`, import.meta.url).href,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
  load(url: string, context: unknown, nextLoad: (url: string, context: unknown) => unknown) {
    if (url.endsWith(".tsx")) {
      return {
        format: "module",
        source: ts.transpileModule(readFileSync(new URL(url), "utf8"), {
          compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext },
        }).outputText,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

Object.defineProperty(globalThis, "localStorage", {
  value: { getItem: () => null },
  configurable: true,
});
Object.defineProperty(globalThis, "window", {
  value: { crypto: globalThis.crypto },
  configurable: true,
});
let finishDownload: (rid: number) => void;
let failDownload: (error: Error) => void;
let progress: (event: unknown) => void;
const commands: string[] = [];
mockIPC((command, args) => {
  commands.push(command);
  if (command === "plugin:updater|check")
    return { rid: 1, version: "1.2.3", currentVersion: "1.2.2" };
  if (command === "plugin:updater|download") {
    progress = (args as { onEvent: { onmessage: (event: unknown) => void } }).onEvent.onmessage;
    return new Promise<number>((resolve, reject) => {
      finishDownload = resolve;
      failDownload = reject;
    });
  }
  throw new Error(`Unexpected native command: ${command}`);
});
const updater = await import("../src/lib/updater/use-update.ts");
// TSX is compiled by the test loader above.
const { UpdateCard } = await import("../src/components/update/update-card.tsx");
function state() {
  let snapshot: ReturnType<typeof updater.useUpdate>;
  function Probe() {
    snapshot = updater.useUpdate();
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  return snapshot!;
}

test("downloading card exposes an accessible minimize control without cancelling the download", async () => {
  await updater.checkForUpdate(true);
  const download = updater.downloadUpdate();
  const card = load(renderToStaticMarkup(createElement(UpdateCard)));
  const minimize = card('button[aria-label="Minimize update download"]');
  assert.equal(minimize.length, 1);
  assert.match(minimize.attr("class") ?? "", /focus-visible:ring-2/);
  updater.closeUpdatePanel();
  progress({ event: "Started", data: { contentLength: 100 } });
  progress({ event: "Progress", data: { chunkLength: 40 } });
  assert.equal(state().panelOpen, false);
  assert.equal(state().status, "downloading");
  assert.equal(state().progress, 0.4);
  assert.equal(state().dismissed, null);
  assert.deepEqual(commands, ["plugin:updater|check", "plugin:updater|download"]);
  updater.openUpdatePanel();
  assert.equal(state().progress, 0.4);
  finishDownload(2);
  await download;
  assert.equal(state().status, "downloaded");
});

test("completion resurfaces a minimized download with install controls", async () => {
  await updater.checkForUpdate(true);
  const download = updater.downloadUpdate();
  updater.closeUpdatePanel();
  finishDownload(3);
  await download;
  assert.equal(state().panelOpen, true);
  const card = load(renderToStaticMarkup(createElement(UpdateCard)));
  assert.match(card.text(), /Update ready to install/);
  assert.match(card.text(), /Install & restart/);
});

test("failure resurfaces a minimized download with a working retry", async () => {
  await updater.checkForUpdate(true);
  const download = updater.downloadUpdate();
  updater.closeUpdatePanel();
  failDownload(new Error("Network interrupted"));
  await download;
  assert.equal(state().status, "error");
  assert.equal(state().panelOpen, true);
  const card = load(renderToStaticMarkup(createElement(UpdateCard)));
  assert.match(card.text(), /Network interrupted/);
  assert.match(card.text(), /Try again/);
  await updater.checkForUpdate(true);
  assert.equal(state().status, "available");
});
