// Minimal React hook host for behavioral hook tests (no DOM, no packages).
//
// tests/auto-end-exit.test.ts registers a node:module resolve hook that maps
// the "react" specifier of src/views/player/hooks/use-auto-end-exit.ts to
// this module, so the REAL hook runs its REAL useEffect/useRef calls here.
// createHookRunner() then drives renders with React's commit semantics:
// deps compared with Object.is, every changed effect's cleanup runs before
// any effect body (cleanup-all-before-setup-all), unmount runs cleanups.

let active = null;

function requireContext() {
  if (!active) throw new Error("hook called outside createHookRunner().render()");
  return active;
}

/** React-compatible useRef: the slot persists across renders. */
export function useRef(initial) {
  const ctx = requireContext();
  const index = ctx.refIndex++;
  if (!ctx.refs[index]) ctx.refs[index] = { current: initial };
  return ctx.refs[index];
}

/** React-compatible useEffect: collected during render, committed after it. */
export function useEffect(run, deps) {
  requireContext().effects.push({ run, deps });
}

function depsEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!Object.is(a[i], b[i])) return false;
  }
  return true;
}

export function createHookRunner(useHook) {
  const refs = [];
  const slots = [];
  let props;

  return {
    render(nextProps) {
      if (nextProps !== undefined) props = nextProps;
      const ctx = { refs, refIndex: 0, effects: [] };
      active = ctx;
      let result;
      try {
        result = useHook(props);
      } finally {
        active = null;
      }

      const changed = [];
      for (let i = 0; i < ctx.effects.length; i += 1) {
        const slot = slots[i];
        if (!slot || !depsEqual(slot.deps, ctx.effects[i].deps)) changed.push(i);
      }
      // Effects the hook stopped registering are destroyed too.
      for (let i = ctx.effects.length; i < slots.length; i += 1) {
        if (slots[i].cleanup) slots[i].cleanup();
      }
      slots.length = ctx.effects.length;

      // React commit order: every destroy first, then every create.
      for (const i of changed) {
        const slot = slots[i];
        if (slot && slot.cleanup) {
          slot.cleanup();
          slot.cleanup = undefined;
        }
      }
      for (const i of changed) {
        const record = ctx.effects[i];
        const cleanup = record.run();
        const slot = slots[i] || (slots[i] = {});
        slot.deps = record.deps;
        slot.cleanup = typeof cleanup === "function" ? cleanup : undefined;
      }
      return result;
    },
    unmount() {
      for (const slot of slots) {
        if (slot.cleanup) {
          slot.cleanup();
          slot.cleanup = undefined;
        }
      }
    },
  };
}
