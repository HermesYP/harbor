// Settable stand-in for src/lib/player/playback-clock.ts.
//
// The test's node:module resolve hook maps the hook's
// "@/lib/player/playback-clock" import here, so getPlaybackPosition() is
// controllable without pulling the real clock (and its "react" import) into
// the test process.

let positionSec = 0;

export function setPlaybackPosition(pos) {
  positionSec = pos;
}

export function getPlaybackPosition() {
  return positionSec;
}
