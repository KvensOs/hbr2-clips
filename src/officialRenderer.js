'use strict';

// Wraps node-haxball's defaultRenderer (a port of the game's own renderer) on top of a
// node-canvas canvas. The renderer only asks its room for extrapolate(), currentPlayerId and
// librariesMap, so a fake room that always returns the current replay state is enough.
const { createCanvas } = require('canvas');

// lossless, lowest compression: frames are temporary and only ffmpeg reads them once
const PNG_OPTS = { compressionLevel: 1 };

function createOfficialRenderer({ API, domShim, images, width, height, zoom = 1.5, overlays = true, camera = 'game', smooth = 0.2, ticksPerFrame = 1 }) {
  const DefaultRenderer = require('node-haxball/examples/renderers/defaultRenderer.js');
  const canvas = createCanvas(width, height);
  canvas.style = {};

  const renderer = new DefaultRenderer(API, { canvas, images, paintGame: true });
  let currentState = null;
  renderer.room = { currentPlayerId: -1, librariesMap: {}, extrapolate: () => currentState };
  renderer.initialize();
  renderer.zoomCoeff = zoom;

  // camera 'game': the game's own follow, it eases toward the ball 4% per frame so it lags behind
  // fast plays. camera 'ball': we move the camera ourselves, `smooth` is the fraction of the
  // distance to the ball covered per tick (1 = locked on the ball).
  const followBall = camera === 'ball';
  if (followBall) renderer.followMode = false;
  const k = 1 - (1 - smooth) ** ticksPerFrame;
  let lastTick = null;

  function moveCamera(state, tick) {
    const ball = state.gameState.physicsState.discs[0].pos;
    const o = renderer.getOrigin();
    // jump to the ball on the first frame and after any gap (between goal windows)
    const snap = lastTick === null || tick - lastTick > ticksPerFrame * 2;
    lastTick = tick;
    renderer.setOrigin(snap ? { x: ball.x, y: ball.y } : { x: o.x + (ball.x - o.x) * k, y: o.y + (ball.y - o.y) * k });
  }

  return {
    // state: replayReader.state, dtMs: how many ms of video this frame stands for, tick: replay tick
    render(state, dtMs, tick) {
      currentState = state;
      domShim.advanceClock(dtMs);
      if (followBall) moveCamera(state, tick);
      renderer.render();
      return canvas.toBuffer('image/png', PNG_OPTS);
    },
    onTeamGoal(...args) { if (overlays) renderer.onTeamGoal(...args); },
    onGameStart(...args) { renderer.onGameStart(...args); },
  };
}

module.exports = { createOfficialRenderer };
