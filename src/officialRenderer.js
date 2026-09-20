'use strict';

// Wraps node-haxball's defaultRenderer (a port of the game's own renderer) on top of a
// node-canvas canvas. The renderer only asks its room for extrapolate(), currentPlayerId and
// librariesMap, so a fake room that always returns the current replay state is enough.
const { createCanvas } = require('canvas');

// lossless, lowest compression: frames are temporary and only ffmpeg reads them once
const PNG_OPTS = { compressionLevel: 1 };

function createOfficialRenderer({ API, domShim, images, width, height, zoom = 1.5, overlays = true }) {
  const DefaultRenderer = require('node-haxball/examples/renderers/defaultRenderer.js');
  const canvas = createCanvas(width, height);
  canvas.style = {};

  const renderer = new DefaultRenderer(API, { canvas, images, paintGame: true });
  let currentState = null;
  renderer.room = { currentPlayerId: -1, librariesMap: {}, extrapolate: () => currentState };
  renderer.initialize();
  renderer.zoomCoeff = zoom;

  return {
    // state: replayReader.state, dtMs: how many ms of video this frame stands for
    render(state, dtMs) {
      currentState = state;
      domShim.advanceClock(dtMs);
      renderer.render();
      return canvas.toBuffer('image/png', PNG_OPTS);
    },
    onTeamGoal(...args) { if (overlays) renderer.onTeamGoal(...args); },
    onGameStart(...args) { renderer.onGameStart(...args); },
  };
}

module.exports = { createOfficialRenderer };
