// @ts-nocheck -- Node's test modules are outside the app TypeScript config.
import assert from "node:assert/strict";
import test from "node:test";
import { createPlayerWindowLock } from "../src/lib/player/window-lock.ts";

test("locking prevents dragging and resizing, unlocking restores window capabilities", async () => {
  const calls = [];
  const lock = createPlayerWindowLock({
    isResizable: async () => true,
    setResizable: async (value) => calls.push(value),
  });
  assert.equal(lock.isLocked(), false);
  await lock.setLocked(true);
  assert.equal(lock.isLocked(), true);
  assert.deepEqual(calls, [false]);
  await lock.setLocked(false);
  assert.equal(lock.isLocked(), false);
  assert.deepEqual(calls, [false, true]);
});

test("native maximize is disabled while locked and its original state restored", async () => {
  const calls = [];
  const lock = createPlayerWindowLock({
    isResizable: async () => true,
    setResizable: async () => {},
    isMaximizable: async () => true,
    setMaximizable: async (value) => calls.push(value),
  });
  await lock.setLocked(true);
  await lock.setLocked(false);
  assert.deepEqual(calls, [false, true]);
});

test("native movement is restored while locked and unsubscribed on unlock", async () => {
  const calls = [];
  let onMoved;
  const lock = createPlayerWindowLock({
    isResizable: async () => false,
    setResizable: async (value) => calls.push(["resize", value]),
    outerPosition: async () => ({ x: 50, y: 80 }),
    onMoved: async (fn) => {
      onMoved = fn;
      return () => calls.push(["unlisten"]);
    },
    setPosition: async (position) => calls.push(["position", position]),
  });
  await lock.setLocked(true);
  await onMoved({ payload: { x: 50, y: 80 } });
  await onMoved({ payload: { x: 10, y: 20 } });
  await lock.setLocked(false);
  await onMoved({ payload: { x: 1, y: 2 } });
  assert.deepEqual(calls, [
    ["resize", false],
    ["position", { x: 50, y: 80 }],
    ["resize", false],
    ["unlisten"],
  ]);
});

test("rapid lock then cleanup restores resizability after pending native calls", async () => {
  let resolve;
  const calls = [];
  const lock = createPlayerWindowLock({
    isResizable: () =>
      new Promise((r) => {
        resolve = r;
      }),
    setResizable: async (value) => calls.push(value),
  });
  const entering = lock.setLocked(true);
  const leaving = lock.setLocked(false);
  await Promise.resolve();
  resolve(true);
  await Promise.all([entering, leaving]);
  assert.equal(lock.isLocked(), false);
  assert.deepEqual(calls, [false, true]);
});

test("failed unlock remains retryable without losing the original resize state", async () => {
  let fail = false;
  const calls = [];
  const lock = createPlayerWindowLock({
    isResizable: async () => true,
    setResizable: async (value) => {
      if (fail) throw new Error("denied");
      calls.push(value);
    },
  });
  await lock.setLocked(true);
  fail = true;
  await assert.rejects(lock.setLocked(false), /denied/);
  assert.equal(lock.isLocked(), true);
  fail = false;
  await lock.setLocked(false);
  assert.deepEqual(calls, [false, true]);
});

test("failed lock releases its movement subscription", async () => {
  let released = false;
  const lock = createPlayerWindowLock({
    isResizable: async () => true,
    outerPosition: async () => ({ x: 1, y: 2 }),
    onMoved: async () => () => {
      released = true;
    },
    setResizable: async () => {
      throw new Error("denied");
    },
  });
  await assert.rejects(lock.setLocked(true), /denied/);
  assert.equal(released, true);
  assert.equal(lock.isLocked(), false);
});

test("native errors do not claim success or poison subsequent attempts", async () => {
  let fail = true;
  const lock = createPlayerWindowLock({
    isResizable: async () => true,
    setResizable: async () => {
      if (fail) throw new Error("denied");
    },
  });
  await assert.rejects(lock.setLocked(true), /denied/);
  assert.equal(lock.isLocked(), false);
  fail = false;
  await lock.setLocked(true);
  assert.equal(lock.isLocked(), true);
});
