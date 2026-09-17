// @ts-nocheck -- Node harness loads the real TSX without a browser test framework.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import ts from "typescript";

let locked = false;
globalThis.__playerLockTest = { isLocked: () => locked };
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "./player-window-lock") return { url: "test:lock", shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === "test:lock")
      return {
        format: "module",
        source: "export const usePlayerWindowLock = () => globalThis.__playerLockTest;",
        shortCircuit: true,
      };
    if (url.endsWith("drag-click-stage.tsx"))
      return {
        format: "module",
        source: ts.transpileModule(readFileSync(new URL(url), "utf8"), {
          compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext },
        }).outputText,
        shortCircuit: true,
      };
    return next(url, context);
  },
});
const { DragClickStage } = await import("../src/views/player/drag-click-stage.tsx");

function stage() {
  let clicks = 0;
  let doubles = 0;
  let volume = 0;
  const handlers = new Map();
  globalThis.window = {
    addEventListener: (name, fn) => handlers.set(name, fn),
    removeEventListener: (name) => handlers.delete(name),
  };
  const element = DragClickStage({
    drawMode: false,
    pipMode: false,
    onClick: () => clicks++,
    onDoubleClick: () => doubles++,
    onWheelVolume: (v) => (volume += v),
  });
  const target = {};
  const event = { target, currentTarget: target, button: 0, clientX: 0, clientY: 0 };
  return { element, event, handlers, counts: () => ({ clicks, doubles, volume }) };
}

test("locked player keeps click-to-pause and volume but ignores accidental fullscreen double-click", () => {
  locked = true;
  const { element, event, handlers, counts } = stage();
  element.props.onMouseDown(event);
  handlers.get("mousemove")({ clientX: 100, clientY: 100 });
  handlers.get("mouseup")();
  element.props.onWheel({ deltaY: 10 });
  element.props.onDoubleClick(event);
  assert.deepEqual(counts(), { clicks: 1, doubles: 0, volume: 10 });
  assert.equal(handlers.size, 0);
});

test("unlocked player retains double-click fullscreen", () => {
  locked = false;
  const { element, event, counts } = stage();
  element.props.onDoubleClick(event);
  assert.equal(counts().doubles, 1);
});

test.after(() => {
  hooks.deregister();
  delete globalThis.__playerLockTest;
  delete globalThis.window;
});
