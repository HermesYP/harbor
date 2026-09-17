// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { runInNewContext } from "node:vm";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";

type Tweaks = Record<string, string>;
type Element = { type: unknown; props: { children?: unknown; onClick?: () => void } };
type DialsModule = {
  PictureDialsSection: () => Element;
  PICTURE_TEMPLATES: { label: string; patch: Tweaks }[];
};

const source = readFileSync(
  new URL("../src/views/settings/mpv-panel/dials.tsx", import.meta.url),
  "utf8",
);
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function buttons(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(buttons);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return element.type === "button" ? [element] : buttons(element.props.children);
}

function picture(initial?: Tweaks) {
  let settings: { mpvTweaks?: Tweaks } = { mpvTweaks: initial };
  const deps: Record<string, unknown> = {
    "react/jsx-runtime": jsxRuntime,
    "lucide-react": { RotateCcw: "icon" },
    "@/components/dropdown": { Dropdown: "dropdown" },
    "@/lib/settings": {
      useSettings: () => ({
        settings,
        update: (patch: Partial<typeof settings>) => {
          settings = { ...settings, ...patch };
        },
      }),
    },
    "@/lib/i18n": { useT: () => (text: string) => text },
    "../shared": { Section: "section", ToggleRow: "toggle" },
  };
  const exports = {} as DialsModule;
  // Execute the real component and useTweaks; only storage/UI boundaries are mocked.
  runInNewContext(output, {
    exports,
    require: (id: string) => {
      assert.ok(id in deps, `Unexpected dependency: ${id}`);
      return deps[id];
    },
  });
  return {
    templates: exports.PICTURE_TEMPLATES,
    click(label: string) {
      // Rerender after each update so handlers see the latest settings snapshot.
      const button = buttons(exports.PictureDialsSection()).find((element) => {
        const children = element.props.children;
        return children === label || (Array.isArray(children) && children.includes(label));
      });
      assert.ok(button?.props.onClick, `Missing button: ${label}`);
      button!.props.onClick!();
    },
    get: () => JSON.parse(JSON.stringify(settings.mpvTweaks)) as Tweaks,
  };
}

const unrelated = { "tone-mapping": "hable", "audio-delay": "0.25" };
const manual = {
  brightness: "40",
  contrast: "30",
  gamma: "20",
  saturation: "10",
  sharpen: "1.5",
  ...unrelated,
};
const templates = picture().templates;

for (const from of templates) {
  for (const to of templates) {
    test(`picture preset ${from.label} -> ${to.label} replaces all picture adjustments`, () => {
      const p = picture(manual);
      p.click(from.label);
      p.click(to.label);
      assert.deepEqual(p.get(), { ...unrelated, ...to.patch });
    });
  }
}

test("punchier color followed by brighten leaves no color or contrast overrides", () => {
  const p = picture();
  p.click("Punchier color");
  p.click("Brighten dark movies");
  assert.deepEqual(p.get(), { gamma: "12", brightness: "4" });
});

test("reset picture clears manual adjustments without changing unrelated mpv tweaks", () => {
  const p = picture(manual);
  p.click("Reset picture");
  assert.deepEqual(p.get(), unrelated);
});

test("each preset initializes missing tweaks and can be reset to defaults", () => {
  for (const template of templates) {
    const p = picture();
    p.click(template.label);
    assert.deepEqual(p.get(), { ...template.patch });
    p.click("Reset picture");
    assert.deepEqual(p.get(), {});
  }
});
