// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { registerHooks } from "node:module";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import {
  createEndExitScheduler,
  POST_END_DELAY_MS,
} from "../src/views/player/hooks/end-exit-scheduler.ts";

type AutoEndExitModule = typeof import("../src/views/player/hooks/use-auto-end-exit.ts");
type AutoEndExitParams = Parameters<AutoEndExitModule["useAutoEndExit"]>[0];
type AutoEndExitHook = AutoEndExitModule["useAutoEndExit"];

const hookSource = readFileSync(
  new URL("../src/views/player/hooks/use-auto-end-exit.ts", import.meta.url),
  "utf8",
);

const HOOK_URL = new URL(
  "../src/views/player/hooks/use-auto-end-exit.ts",
  import.meta.url,
).href;
const REACT_HOST_URL = new URL("./shims/react-hook-host.mjs", import.meta.url).href;
const CLOCK_STUB_URL = new URL("./shims/playback-clock-stub.mjs", import.meta.url).href;
const SRC_ROOT_URL = new URL("../src/", import.meta.url);
const TS_EXTENSION = /\.[cm]?[jt]sx?$/;

// Load the REAL hook with its runtime collaborators shimmed: "react" becomes
// the effect/ref host, the playback clock becomes a settable stub, and the
// extensionless bundler-style specifiers resolve with ".ts" appended.
registerHooks({
  resolve(
    specifier: string,
    context: { parentURL?: string },
    nextResolve: (s: string, c: unknown) => unknown,
  ) {
    if (context.parentURL === HOOK_URL) {
      if (specifier === "react") return { url: REACT_HOST_URL, shortCircuit: true };
      if (specifier === "@/lib/player/playback-clock") {
        return { url: CLOCK_STUB_URL, shortCircuit: true };
      }
      if (specifier.startsWith("@/")) {
        const path = specifier.slice(2);
        return {
          url: new URL(TS_EXTENSION.test(path) ? path : `${path}.ts`, SRC_ROOT_URL).href,
          shortCircuit: true,
        };
      }
      if (specifier.startsWith(".") && !TS_EXTENSION.test(specifier)) {
        return {
          url: new URL(`${specifier}.ts`, context.parentURL).href,
          shortCircuit: true,
        };
      }
    }
    return nextResolve(specifier, context);
  },
});

const { useAutoEndExit } = (await import(HOOK_URL)) as AutoEndExitModule;
const { createHookRunner } = (await import(REACT_HOST_URL)) as {
  createHookRunner: (hook: AutoEndExitHook) => {
    render: (props: AutoEndExitParams) => void;
    unmount: () => void;
  };
};
const { setPlaybackPosition } = (await import(CLOCK_STUB_URL)) as {
  setPlaybackPosition: (pos: number) => void;
};

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

/**
 * Stable fixture for the real hook: every render returns a fresh top-level
 * object whose callback/ref identities never change, so a re-render differs
 * only in holdForEndRecommendations — exactly the transition useTitleDetail
 * drives (loading=false -> loading=true -> settles empty).
 */
function makeBaseProps(closePlayer: () => void): Omit<AutoEndExitParams, "holdForEndRecommendations"> {
  return {
    src: {
      meta: { id: "tt0111111", type: "movie", name: "EOF Race" },
      url: "magnet:eof-race",
      title: "EOF Race",
    },
    snap: {
      status: "ended",
      positionSec: 3600,
      durationSec: 3600,
      bufferedSec: 3600,
      buffering: false,
      volume: 100,
      muted: false,
      rate: 1,
      audioTracks: [],
      subtitleTracks: [],
      chapters: [],
      subDelaySec: 0,
      audioDelaySec: 0,
      subText: "",
      subStartSec: 0,
      audioNormalize: false,
      videoWidth: 1920,
      videoHeight: 1080,
      hdrGamma: "",
      errorMessage: null,
      errorCode: null,
    },
    nextEp: null,
    canChangeEpisode: false,
    roomGuest: false,
    isLive: false,
    suspend: false,
    startedNearEndRef: { current: false },
    reloadLive: () => {},
    closePlayer,
  };
}

test("the real hook closes once across the hold false->true->false EOF transition", (t: TimerContext) => {
  const timers = mockEndTimers(t);
  setPlaybackPosition(3600);
  const runner = createHookRunner(useAutoEndExit);
  let closed = 0;
  const closePlayer = () => {
    closed += 1;
  };
  const base = makeBaseProps(closePlayer);
  const props = (holdForEndRecommendations: boolean): AutoEndExitParams => ({
    ...base,
    holdForEndRecommendations,
  });

  // Natural EOF: useTitleDetail first renders with loading=false, so the
  // effect arms the 800ms close while the hold is still released.
  runner.render(props(false));
  // loading=true -> hold=true: React re-runs the effect; its cleanup
  // cancels the pending timer and the hold gate returns without arming.
  runner.render(props(true));
  timers.tick(POST_END_DELAY_MS * 2);
  assert.equal(closed, 0, "the cancelled schedule must not fire while held");

  // The detail request settles empty -> hold=false: the effect re-runs and
  // must re-arm, or the player stays open forever.
  runner.render(props(false));
  timers.tick(POST_END_DELAY_MS - 1);
  assert.equal(closed, 0, "the close keeps the full post-end delay");
  timers.tick(1);
  assert.equal(closed, 1, "the re-armed close fires exactly once");

  // A later hold flicker cannot schedule a second close for this source.
  runner.render(props(true));
  runner.render(props(false));
  timers.tick(POST_END_DELAY_MS * 2);
  assert.equal(closed, 1, "the fired close is never armed again");
  runner.unmount();
});

test("the real hook cancels its pending close on unmount", (t: TimerContext) => {
  const timers = mockEndTimers(t);
  setPlaybackPosition(3600);
  const runner = createHookRunner(useAutoEndExit);
  let closed = 0;
  const base = makeBaseProps(() => {
    closed += 1;
  });

  runner.render({ ...base, holdForEndRecommendations: false });
  runner.unmount();
  timers.tick(POST_END_DELAY_MS * 2);
  assert.equal(closed, 0, "unmount cleanup must cancel the armed close");
});

test("a cancelled schedule re-arms after the overlay hold settles empty", (t: TimerContext) => {
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

test("a close that fired is never re-armed for the same source", (t: TimerContext) => {
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

test("cancellation without a re-run leaves no timer behind", (t: TimerContext) => {
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

test("reset forgets both the pending timer and the fired source", (t: TimerContext) => {
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
  assert.match(hookSource, /scheduler\.schedule\(src\.url,/);
  assert.match(hookSource, /return \(\) => scheduler\.cancel\(\)/);
  assert.match(hookSource, /schedulerRef\.current\.reset\(\)/);
  // The "closed" marker must never be written at schedule time — that is
  // exactly the EOF race where a cancelled schedule could not re-arm.
  assert.doesNotMatch(hookSource, /firedForRef/);
  assert.doesNotMatch(hookSource, /window\.setTimeout\(\(\) => \{\s*void closePlayer/);
});
