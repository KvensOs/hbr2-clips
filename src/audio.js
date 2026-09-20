'use strict';

// Builds the audio track of a clip: kick / goal / crowd sounds from res.dat placed at the
// exact tick of each event, written as a mono 44.1 kHz wav. ffmpeg muxes it into the mp4.
const fs = require('fs');
const { spawnSync } = require('child_process');

const SR = 44100;
// the raw sounds are very quiet inside a video (kick peaks at -13 dB), so boost them and
// normalize the final mix
const GAIN = { kick: 2.2, goal: 1.5, crowd: 0.9 };
const TARGET_PEAK = 0.89; // about -1 dBFS
const FADE_OUT_S = 0.25;  // the clip ends while the crowd is still going

const decoded = new WeakMap();
function decodeToFloat(soundBuffer) {
  if (!decoded.has(soundBuffer)) decoded.set(soundBuffer, decode(soundBuffer));
  return decoded.get(soundBuffer);
}

function decode(soundBuffer) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-f', 's16le', '-ac', '1', '-ar', String(SR), 'pipe:1'],
    { input: soundBuffer, maxBuffer: 1 << 28 });
  if (r.error) throw new Error('could not run ffmpeg: ' + r.error.message);
  if (r.status !== 0) throw new Error('ffmpeg could not decode a sound:\n' + r.stderr);
  const raw = r.stdout;
  if (!raw || raw.length < 4) throw new Error('ffmpeg decoded 0 samples (broken res.dat?)');
  // copy first, a Buffer can start at an odd offset and Int16Array won't take that
  const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length - (raw.length % 2));
  const pcm = new Int16Array(ab);
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768;
  return out;
}

function writeWav(path, samples) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(path, Buffer.concat([h, data]));
}

// sounds:     { kick, goal, crowd } buffers from loadAssets
// kicks:      kick times in seconds, relative to the clip start
// goalT:      goal time in seconds (or null)
// crowdGains: crowd gain per tick from the clip start (see crowd.js), or null
function buildTrack({ sounds, durationS, kicks, goalT, crowdGains = null, gainsPerS = 60, outPath }) {
  const out = new Float32Array(Math.ceil(durationS * SR));
  const add = (pcm, tSeg, gain) => {
    const off = Math.round(tSeg * SR);
    for (let i = 0; i < pcm.length && off + i < out.length; i++) if (off + i >= 0) out[off + i] += pcm[i] * gain;
  };
  const kick = decodeToFloat(sounds.kick);
  const goal = decodeToFloat(sounds.goal);
  kicks.forEach((t) => add(kick, t, GAIN.kick));

  if (crowdGains && crowdGains.length) {
    const bed = decodeToFloat(sounds.crowd);
    const last = crowdGains.length - 1;
    for (let i = 0; i < out.length; i++) {
      const k = (i / SR) * gainsPerS;
      const k0 = Math.min(Math.floor(k), last), k1 = Math.min(k0 + 1, last);
      const g = crowdGains[k0] + (crowdGains[k1] - crowdGains[k0]) * (k - k0); // lerp so there are no 60 Hz steps
      if (g > 0.0005) out[i] += bed[i % bed.length] * g * GAIN.crowd;
    }
  }
  if (goalT != null) add(goal, goalT, GAIN.goal);

  const fade = Math.min(Math.round(FADE_OUT_S * SR), out.length);
  for (let i = 0; i < fade; i++) out[out.length - 1 - i] *= i / fade;

  let peak = 0;
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0) { const k = TARGET_PEAK / peak; for (let i = 0; i < out.length; i++) out[i] *= k; }

  writeWav(outPath, out);
  return outPath;
}

module.exports = { buildTrack };
