'use strict';

// DOM de mentiras para que el defaultRenderer de node-haxball corra en Node. Solo toca
// window.document.createElement("canvas"), window.performance.now(), window.devicePixelRatio
// y canvas.style.
//
// El reloj es falso: el renderer anima con performance.now() (el easing de la cámara, el
// texto "Red Scores!"), y como estamos renderizando offline lo movemos nosotros a mano, un
// frame de video por cada frame dibujado. Con el reloj real la cámara y las animaciones irían
// a la velocidad que no es.
const { createCanvas } = require('canvas');

let nowMs = 0;

function installDomShim() {
  global.window = {
    devicePixelRatio: 1,
    performance: { now: () => nowMs },
    document: {
      createElement(tag) {
        if (tag !== 'canvas') throw new Error(`domShim only supports <canvas>, got <${tag}>`);
        const c = createCanvas(300, 150);
        c.style = {}; // el renderer hace canvas.style.filter = ""
        return c;
      },
    },
  };
  return {
    advanceClock: (ms) => { nowMs += ms; },
  };
}

module.exports = { installDomShim };
