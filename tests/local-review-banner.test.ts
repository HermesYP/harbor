// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { createRequire } from "node:module";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import ts from "typescript";
import type { LocalEntry } from "../src/lib/local-library";

const require = createRequire(import.meta.url);
function loadSource(path: string, dependencies: Record<string, unknown> = {}) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} as Record<string, (...args: any[]) => any> };
  new Function("require", "module", "exports", compiled)(
    (name: string) => dependencies[name] ?? require(name),
    module,
    module.exports,
  );
  return module.exports;
}

const entry = (id: string, patch: Partial<LocalEntry> = {}): LocalEntry => ({
  id,
  path: `/media/${id}.mkv`,
  filename: `${id}.mkv`,
  title: id,
  year: null,
  type: "movie",
  addedAt: 1,
  needsReview: true,
  ...patch,
});

function fixture(items: LocalEntry[]) {
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  });
  const library = loadSource("../src/lib/local-library.ts");
  library.addLocalEntries(items);
  let identified: unknown;
  const noop = () => null;
  const componentStubs = new Proxy({}, { get: () => noop });
  const groupLocal = (entries: LocalEntry[]) =>
    entries.map((item) => ({ kind: "movie", entry: item }));
  const dependencies: Record<string, unknown> = {
    react: {
      useState: (value: unknown) => [
        value,
        (next: unknown) => {
          identified = next;
        },
      ],
      useMemo: (fn: () => unknown) => fn(),
      useCallback: (fn: unknown) => fn,
      useEffect: noop,
    },
    "@/lib/local-library": { ...library, useLocalLibrary: library.readLocalLibrary },
    "@/lib/i18n": { useT: () => (key: string) => key },
    "@/lib/settings": { useSettings: () => ({ settings: {} }) },
    "@/lib/view": { useView: () => ({ openMeta: noop }) },
    "./local-tab/show-group": { groupLocal, ShowGroupCard: noop },
    "./local-tab/toolbar": { ...componentStubs, sortGroups: (value: unknown) => value },
  };
  for (const name of [
    "@/lib/local-library/sidecars",
    "@/lib/local-library/export",
    "@/lib/dialog",
    "./shared",
    "./local-tab/scan-mode-modal",
    "./local-tab/identify-modal",
    "./local-tab/movie-card",
    "./local-tab/scan",
  ])
    dependencies[name] = componentStubs;
  const { LocalTab } = loadSource("../src/views/library/local-tab.tsx", dependencies);
  return { render: LocalTab, library, identified: () => identified };
}

function elements(node: any): any[] {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(elements);
  return [node, ...elements(node.props?.children)];
}

function text(node: any): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(text).join("");
  return node && typeof node === "object" ? text(node.props?.children) : "";
}

test("Ignore dismisses pending reviews without removing media or changing metadata", () => {
  const items = [
    entry("movie"),
    entry("episode", { type: "show", season: 1, episode: 1 }),
    entry("identified", { needsReview: false, tmdbId: 12 }),
  ];
  const { render, library } = fixture(items);
  const ignore = elements(render()).find(
    (node) => node.type === "button" && text(node) === "Ignore",
  );
  assert.ok(ignore, "The local-media review banner must offer an Ignore button");
  ignore.props.onClick();
  const expected = items.map((item) => ({ ...item, needsReview: false }));
  assert.deepEqual(library.readLocalLibrary(), expected);
  const reloadedLibrary = loadSource("../src/lib/local-library.ts");
  assert.deepEqual(reloadedLibrary.readLocalLibrary(), expected);
  assert.ok(!elements(render()).some((node) => node.type === "button" && text(node) === "Ignore"));
  library.addLocalEntries([entry("new-title")]);
  assert.ok(elements(render()).some((node) => node.type === "button" && text(node) === "Ignore"));
});

test("Review still opens identification and is not nested around Ignore", () => {
  const items = [entry("movie")];
  const { render, library, identified } = fixture(items);
  const buttons = elements(render()).filter((node) => node.type === "button");
  const review = buttons.find((node) => text(node) === "Review");
  assert.ok(review);
  review.props.onClick();
  assert.deepEqual(identified(), items);
  assert.deepEqual(library.readLocalLibrary(), items);
  for (const button of buttons) {
    assert.ok(!elements(button.props.children).some((node) => node.type === "button"));
  }
});

test("No review actions are shown when the library has no pending reviews", () => {
  const { render } = fixture([entry("identified", { needsReview: false })]);
  assert.ok(
    !elements(render()).some(
      (node) => node.type === "button" && ["Ignore", "Review"].includes(text(node)),
    ),
  );
});
