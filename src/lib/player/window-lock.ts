type Position = { x: number; y: number };
type LockWindow = {
  isResizable: () => Promise<boolean>;
  setResizable: (value: boolean) => Promise<void>;
  isMaximizable?: () => Promise<boolean>;
  setMaximizable?: (value: boolean) => Promise<void>;
  outerPosition?: () => Promise<Position>;
  setPosition?: (position: Position) => Promise<void>;
  onMoved?: (callback: (event: { payload: Position }) => void) => Promise<() => void>;
};

export function createPlayerWindowLock(window: LockWindow) {
  let locked = false;
  let resizable = true;
  let maximizable = true;
  let unlisten: (() => void) | undefined;
  let queue = Promise.resolve();

  async function apply(value: boolean) {
    if (value === locked) return;
    if (value) {
      resizable = await window.isResizable();
      maximizable = (await window.isMaximizable?.()) ?? true;
      const position = await window.outerPosition?.();
      if (position && window.onMoved) {
        unlisten = await window.onMoved(({ payload }) => {
          if (locked && (payload.x !== position.x || payload.y !== position.y)) {
            void window.setPosition?.(position).catch(() => {});
          }
        });
      }
      try {
        await window.setMaximizable?.(false);
        await window.setResizable(false);
      } catch (error) {
        await window.setMaximizable?.(maximizable).catch(() => {});
        unlisten?.();
        unlisten = undefined;
        throw error;
      }
    } else {
      await window.setMaximizable?.(maximizable);
      await window.setResizable(resizable);
      unlisten?.();
      unlisten = undefined;
    }
    locked = value;
  }

  return {
    isLocked: () => locked,
    setLocked(value: boolean) {
      const result = queue.then(() => apply(value));
      queue = result.catch(() => {});
      return result;
    },
  };
}
