// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import {
  createEndExitScheduler,
  POST_END_DELAY_MS,
} from "../src/views/player/hooks/end-exit-scheduler.ts";

const hookSource = readFileSync(
  new URL("../src/views/player/hooks/use-auto-end-exit.ts", import.meta.url),
  "utf8",
);

/**
 * Mirrors the React effect contract of useAutoEndExit: every run either
 * returns a cleanup (the end-of-playback gates let it arm the close) or
 * nothing (a gate — hold/suspend/next-episode — returned early), and React
 * always invokes the previous cleanup before the next run starts.
 */
function createEffectDriver(scheduler: ReturnType<typeof createEndExitScheduler>, key: string) {
  let cleanup: (() => void) | null = null;
  let closed = 0;
  return {
    /** Run one effect pass; `armed` is false when a gate returned early. */
    run(armedGate: boolean) {
      cleanup?.();
      cleanup = null;
      if (!armedGate) return;
      const armed = scheduler.schedule(key, () => {
        closed += 1;
      });
      if (armed) cleanup = () => scheduler.cancel();
    },
    get closed() {
      return closed;
    },
    unmount() {
      cleanup?.();
      cleanup = null;
    },
  };
}

type TimerContext = {
  mock: {
    timers: {
      enable: (options: { apis: string[] }) => void;
      tick: (ms: number) => void;
    };
  };
};

function mockEndTimers(t: TimerContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  return t.mock.timers;
}

test("a cancelled schedule re-arms after the overlay hold settles empty", (t) => {
  const timers = mockEndTimers(t);
  const scheduler = createEndExitScheduler();
  const driver = createEffectDriver(scheduler, "magnet:natural-eof");

  // Natural EOF: useTitleDetail first renders with loading=false, so the
  // effect runs while holdForEndRecommendations is still false and arms.
  driver.run(true);
  // useTitleDetail's fetch effect sets loading=true -> hold=true: the effect
  // re-runs, its cleanup cancels the pending timer.
  driver.run(false);
  timers.tick(POST_END_DELAY_MS);
  assert.equal(driver.closed, 0, "a cancelled schedule must never fire");

  // The detail request settles empty (or fails) -> hold=false: the effect
  // re-runs and must re-arm, or the player stays open forever.
  driver.run(true);
  timers.tick(POST_END_DELAY_MS - 1);
  assert.equal(driver.closed, 0, "the close keeps the full post-end delay");
  timers.tick(1);
  assert.equal(driver.closed, 1, "the re-armed close fires after the delay");
});

test("a close that fired is never re-armed for the same source", (t) => {
  const timers = mockEndTimers(t);
  const scheduler = createEndExitScheduler();
  const driver = createEffectDriver(scheduler, "magnet:fired-once");

  driver.run(true);
  timers.tick(POST_END_DELAY_MS);
  assert.equal(driver.closed, 1);

  // Further effect runs (hold flickering, live-status churn, ...) must not
  // schedule a second close while this one is in flight.
  driver.run(true);
  timers.tick(POST_END_DELAY_MS * 4);
  assert.equal(driver.closed, 1);
});

test("cancellation without a re-run leaves no timer behind", (t) => {
  const timers = mockEndTimers(t);
  const scheduler = createEndExitScheduler();
  let fired = 0;

  assert.equal(
    scheduler.schedule("magnet:pending", () => {
      fired += 1;
    }),
    true,
  );
  scheduler.cancel();
  timers.tick(POST_END_DELAY_MS * 4);
  assert.equal(fired, 0, "a cancelled timer must not fire later");

  // The same source can still be armed afterwards.
  assert.equal(
    scheduler.schedule("magnet:pending", () => {
      fired += 1;
    }),
    true,
  );
  timers.tick(POST_END_DELAY_MS);
  assert.equal(fired, 1);
});

test("reset forgets both the pending timer and the fired source", (t) => {
  const timers = mockEndTimers(t);
  const scheduler = createEndExitScheduler();
  const driver = createEffectDriver(scheduler, "magnet:old-source");

  driver.run(true);
  timers.tick(POST_END_DELAY_MS);
  assert.equal(driver.closed, 1);
  driver.run(true);
  assert.equal(driver.closed, 1);

  // reset() also applies on a src.url change, so the next source may arm
  // its own close even though this one already fired.
  scheduler.reset();
  const next = createEffectDriver(scheduler, "magnet:new-source");
  next.run(true);
  timers.tick(POST_END_DELAY_MS);
  assert.equal(driver.closed, 1, "the old source stays closed exactly once");
  assert.equal(next.closed, 1, "the new source arms a fresh close");

  // reset() during a pending schedule cancels it as well.
  const pending = createEndExitScheduler();
  let fired = 0;
  pending.schedule("magnet:changed", () => {
    fired += 1;
  });
  pending.reset();
  timers.tick(POST_END_DELAY_MS * 4);
  assert.equal(fired, 0);
});

test("the auto-end-exit effect wires its schedule through the scheduler", () => {
  // Pin the hook to the effect-owned scheduler so the transitions above
  // describe the real effect: arm -> cleanup cancels -> re-arm -> fire.
  assert.match(hookSource, /createEndExitScheduler\(\)/);
  assert.match(hookSource, /schedulerRef\.current\.schedule\(src\.url,/);
  assert.match(hookSource, /return \(\) => schedulerRef\.current\.cancel\(\)/);
  assert.match(hookSource, /schedulerRef\.current\.reset\(\)/);
  // The "closed" marker must never be written at schedule time — that is
  // exactly the EOF race where a cancelled schedule could not re-arm.
  assert.doesNotMatch(hookSource, /firedForRef/);
  assert.doesNotMatch(hookSource, /window\.setTimeout\(\(\) => \{\s*void closePlayer/);
});
