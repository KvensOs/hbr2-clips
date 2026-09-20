'use strict';

// Tiny DOM so node-haxball's defaultRenderer runs in Node. It only touches
// window.document.createElement("canvas"), window.performance.now(), window.devicePixelRatio
// and canvas.style.
//
// The clock is fake: the renderer animates with performance.now() (camera easing, the
// "Red Scores!" text), and since we render offline we move it by hand, one video frame per
// drawn frame. With the real clock the camera and animations would run at the wrong speed.
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
        c.style = {}; // the renderer does canvas.style.filter = ""
        return c;
      },
    },
  };
  return {
    advanceClock: (ms) => { nowMs += ms; },
  };
}

module.exports = { installDomShim };
