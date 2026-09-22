'use strict';

// Volumen del público, portado del cliente oficial. El juego repite crowd.ogg en loop y solo
// mueve la ganancia:
//   - objetivo 1.0 durante la celebración de gol (150 ticks)
//   - objetivo 0.3 en una jugada de "peligro" (ver dangerFromPositions)
//   - un objetivo dura ~166 ms si no se renueva, después vuelve a 0
//   - la ganancia real se acerca al objetivo (2.5% cada ~17 ms) y se corta a 0 por debajo de 0.05
// Un paso por tick es lo bastante cercano al timer de 17 ms del cliente.
const CELEBRATION_TICKS = 150;
const STEP_MS = 17;
const HOLD_MS = 166.66666666666666;
const SMOOTH = 0.025;
const CUT_BELOW = 0.05;

class CrowdModel {
  constructor() { this.gain = 0; this.target = 0; this.holdMs = 0; this.running = false; }

  reset() { this.gain = 0; this.target = 0; this.holdMs = 0; this.running = false; }

  _set(v) { this.target = v; this.holdMs = HOLD_MS; this.running = true; }

  // se llama una vez por tick, devuelve la ganancia (0..1) de ese tick
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

// La misma regla que usa el cliente, copiada tal cual. Red ataca hacia +x, blue hacia -x.
//   A) el jugador de red más cercano a la pelota y la pelota pasaron al jugador más retrasado
//      de blue (x más alta) y la pelota está en x > 20
//   B) el jugador de blue más cercano y la pelota están a la izquierda del jugador de red con
//      x más alta y la pelota está en x < -20
// Sí, B compara contra el jugador más adelantado de red, no el más retrasado. Es lo que hace
// el original, así que se deja así.
// reds / blues: [{x, y}] de los jugadores que tienen disco en la cancha
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

// state = replayReader.state de node-haxball
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
