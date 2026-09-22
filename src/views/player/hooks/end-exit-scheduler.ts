// Effect-owned scheduler for the post-end auto-close.
//
// React runs the auto-end-exit effect again whenever one of its inputs
// changes (the end-recommendations hold flipping with the title-detail
// fetch phase, a late next episode, suspend, ...), and every re-run first
// invokes the previous cleanup, cancelling the pending timer. The
// "already closed" marker must therefore be written only when the timer
// ACTUALLY FIRES: a cancelled schedule has to be re-armable, otherwise a
// natural EOF whose "More Like This" request settles empty (hold
// false -> true -> false) leaves the player open forever.

export const POST_END_DELAY_MS = 800;

export type EndExitScheduler = {
  /** Cancel the pending timer without recording a close for any key. */
  cancel: () => void;
  /** Cancel the pending timer and forget the fired key (new source). */
  reset: () => void;
  /**
   * Arm `fire` after the post-end delay for `key` unless it already fired
   * for `key`. Returns false when a fired close blocks re-arming.
   */
  schedule: (key: string, fire: () => void) => boolean;
};

export function createEndExitScheduler(delayMs: number = POST_END_DELAY_MS): EndExitScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let firedFor: string | null = null;

  const cancel = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  return {
    cancel,
    reset() {
      cancel();
      firedFor = null;
    },
    schedule(key, fire) {
      if (firedFor === key) return false;
      cancel();
      timer = setTimeout(() => {
        timer = null;
        firedFor = key;
        fire();
      }, delayMs);
      return true;
    },
  };
}
