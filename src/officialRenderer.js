'use strict';

// Envuelve el defaultRenderer de node-haxball (un port del renderer propio del juego) sobre un
// canvas de node-canvas. El renderer solo le pide a su room extrapolate(), currentPlayerId y
// librariesMap, así que alcanza con una room falsa que siempre devuelve el estado actual del
// replay.
const { createCanvas } = require('canvas');

// sin pérdida, mínima compresión: los frames son temporales y ffmpeg los lee una sola vez
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

  // cámara 'game': el seguimiento propio del juego, se acerca a la pelota 4% por frame, así que
  // se queda atrás en jugadas rápidas. cámara 'ball': movemos la cámara nosotros, `smooth` es la
  // fracción de la distancia a la pelota que se recorre por tick (1 = pegada a la pelota).
  const followBall = camera === 'ball';
  if (followBall) renderer.followMode = false;
  const k = 1 - (1 - smooth) ** ticksPerFrame;
  let lastTick = null;

  function moveCamera(state, tick) {
    const ball = state.gameState.physicsState.discs[0].pos;
    const o = renderer.getOrigin();
    // salta directo a la pelota en el primer frame y después de cualquier salto (entre ventanas de gol)
    const snap = lastTick === null || tick - lastTick > ticksPerFrame * 2;
    lastTick = tick;
    renderer.setOrigin(snap ? { x: ball.x, y: ball.y } : { x: o.x + (ball.x - o.x) * k, y: o.y + (ball.y - o.y) * k });
  }

  return {
    // state: replayReader.state, dtMs: cuántos ms de video representa este frame, tick: tick del replay
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
