'use strict';

// Lee la lista de goles guardada dentro de un archivo .hbr2, sin necesidad de simular nada.
//
// Formato (big endian):
//   "HBR2" | version u32 | total de ticks u32     header plano
//   cuerpo deflate-raw: cantidad de goles u16, luego por gol [delta de tick varint, equipo u8],
//   después el estado inicial y los eventos de input
//
// El byte de equipo es el equipo que RECIBIÓ el gol (1 red, 2 blue). El tick guardado es uno
// menos que el que da node-haxball en onTeamGoal, así que el `tick` de acá ya tiene el +1.
const zlib = require('zlib');

function readGoalIndex(data) {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'HBR2') throw new Error('not a .hbr2 file');
  const version = buf.readUInt32BE(4);
  const totalTicks = buf.readUInt32BE(8);
  const body = zlib.inflateRawSync(buf.subarray(12));

  let p = 0;
  const need = (n) => { if (p + n > body.length) throw new Error('truncated goal index'); };
  need(2);
  const count = body.readUInt16BE(p); p += 2;

  const goals = [];
  let frame = 0;
  for (let i = 0; i < count; i++) {
    let delta = 0, shift = 0, b;
    do { need(1); b = body[p++]; delta += (b & 127) * 2 ** shift; shift += 7; } while ((b & 128) && shift < 35);
    need(1);
    const conceded = body[p++];
    if (conceded !== 1 && conceded !== 2) throw new Error(`bad team id (${conceded}) in goal index`);
    frame += delta;
    goals.push({ index: i + 1, frame, tick: frame + 1, teamId: 3 - conceded });
  }
  return { version, totalTicks, goals };
}

module.exports = { readGoalIndex };
