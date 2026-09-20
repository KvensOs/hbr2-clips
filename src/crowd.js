'use strict';

// Crowd volume, ported from the official client. The game loops crowd.ogg and only moves its
// gain around:
//   - target 1.0 during the goal celebration (150 ticks)
//   - target 0.3 on a "danger" play (see dangerFromPositions)
//   - a target lasts ~166 ms unless renewed, then goes back to 0
//   - the real gain eases toward the target (2.5% every ~17 ms) and is cut to 0 under 0.05
// One step per tick is close enough to the client's 17 ms timer.
const CELEBRATION_TICKS = 150;
const STEP_MS = 17;
const HOLD_MS = 166.66666666666666;
const SMOOTH = 0.025;
const CUT_BELOW = 0.05;

class CrowdModel {
  constructor() { this.gain = 0; this.target = 0; this.holdMs = 0; this.running = false; }

  reset() { this.gain = 0; this.target = 0; this.holdMs = 0; this.running = false; }

  _set(v) { this.target = v; this.holdMs = HOLD_MS; this.running = true; }

  // call once per tick, returns the gain (0..1) for that tick
  step({ celebrating, danger }) {
    if (celebrating) this._set(1);
    else if (danger) this._set(0.3);
    if (this.running) {
      this.gain += (this.target - this.gain) * SMOOTH;
      this.holdMs -= STEP_MS;
      if (this.holdMs <= 0) { this.holdMs = 0; this.target = 0; }
      if (this.target <= 0 && this.gain < CUT_BELOW) { this.running = false; this.gain = 0; }
    }
    return this.gain;
  }
}

// Same rule the client uses, copied as is. Red attacks toward +x, blue toward -x.
//   A) red's closest player to the ball and the ball are past blue's deepest player
//      (highest x) and the ball is at x > 20
//   B) blue's closest player and the ball are left of red's highest-x player and the ball
//      is at x < -20
// Yes, B compares against red's most advanced player, not the deepest one. That's what the
// original does, so it stays.
// reds / blues: [{x, y}] for players that have a disc on the pitch
function dangerFromPositions(ballX, ballY, reds, blues) {
  if (![ballX, ballY].every(Number.isFinite)) throw new Error('bad ball position');
  if (!reds.length || !blues.length) return false;

  let redMaxX = -Infinity, blueMaxX = -Infinity;
  let nearRed = null, nearRedD = Infinity, nearBlue = null, nearBlueD = Infinity;
  for (const p of reds) {
    if (![p.x, p.y].every(Number.isFinite)) throw new Error('bad player position');
    if (p.x > redMaxX) redMaxX = p.x;
    const d = (p.x - ballX) ** 2 + (p.y - ballY) ** 2;
    if (d < nearRedD) { nearRedD = d; nearRed = p; }
  }
  for (const p of blues) {
    if (![p.x, p.y].every(Number.isFinite)) throw new Error('bad player position');
    if (p.x > blueMaxX) blueMaxX = p.x;
    const d = (p.x - ballX) ** 2 + (p.y - ballY) ** 2;
    if (d < nearBlueD) { nearBlueD = d; nearBlue = p; }
  }
  const a = nearRed.x > blueMaxX && ballX > blueMaxX && ballX > 20;
  const b = nearBlue.x < redMaxX && ballX < redMaxX && ballX < -20;
  return a || b;
}

// state = node-haxball replayReader.state
function readDanger(state) {
  const ball = state.gameState.physicsState.discs[0];
  const reds = [], blues = [];
  for (const p of state.players) {
    if (!p.disc || !p.team) continue;
    const pt = { x: p.disc.pos.x, y: p.disc.pos.y };
    if (p.team.id === 1) reds.push(pt); else if (p.team.id === 2) blues.push(pt);
  }
  return dangerFromPositions(ball.pos.x, ball.pos.y, reds, blues);
}

module.exports = { CrowdModel, dangerFromPositions, readDanger, CELEBRATION_TICKS };
