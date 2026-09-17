// @ts-nocheck -- Node's built-in test modules are outside the app TypeScript config.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("player mounts lock controls independent of the selected shell", () => {
  assert.match(read("src/views/player.tsx"), /PlayerWindowLockProvider/);
  assert.match(read("src/views/player.tsx"), /PlayerWindowLockControl/);
});

test("drag gestures and PiP resize handles honor the player lock", () => {
  assert.match(read("src/views/player/drag-click-stage.tsx"), /usePlayerWindowLock/);
  assert.match(read("src/components/player/transport/pip-chrome.tsx"), /!locked &&/);
});

test("native resize permission is granted only to the main player window", () => {
  const capability = JSON.parse(read("src-tauri/capabilities/player-window-lock.json"));
  assert.deepEqual(capability.windows, ["main"]);
  assert.ok(capability.permissions.includes("core:window:allow-set-resizable"));
});
