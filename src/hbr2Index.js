'use strict';

// Reads the goal list stored inside a .hbr2 file, no simulation needed.
//
// Layout (big endian):
//   "HBR2" | version u32 | total ticks u32        plain header
//   deflate-raw body: goal count u16, then per goal [tick delta varint, team u8],
//   then the initial state and the input events
//
// The team byte is the team that CONCEDED (1 red, 2 blue). The stored tick is one less than
// what node-haxball gives in onTeamGoal, so `tick` here already has the +1.
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
