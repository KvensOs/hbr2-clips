'use strict';

// Arma la pista de audio de un clip: sonidos de patada/gol/público de res.dat colocados en el
// tick exacto de cada evento, escritos como wav mono a 44.1 kHz. ffmpeg lo mezcla dentro del mp4.
const fs = require('fs');
const { spawnSync } = require('child_process');
const { FFMPEG_PATH } = require('./framesToVideo');

const SR = 44100;
// los sonidos crudos suenan muy bajo dentro de un video (la patada pica en -13 dB), así que se
// suben y después se normaliza la mezcla final
const GAIN = { kick: 2.2, goal: 1.5, crowd: 0.9 };
const TARGET_PEAK = 0.89; // unos -1 dBFS
const FADE_OUT_S = 0.25;  // el clip termina mientras el público todavía sigue sonando

const decoded = new WeakMap();
function decodeToFloat(soundBuffer) {
  if (!decoded.has(soundBuffer)) decoded.set(soundBuffer, decode(soundBuffer));
  return decoded.get(soundBuffer);
}

function decode(soundBuffer) {
  const r = spawnSync(FFMPEG_PATH, ['-v', 'error', '-i', 'pipe:0', '-f', 's16le', '-ac', '1', '-ar', String(SR), 'pipe:1'],
    { input: soundBuffer, maxBuffer: 1 << 28 });
  if (r.error) throw new Error('could not run ffmpeg (' + FFMPEG_PATH + '): ' + r.error.message);
  if (r.status !== 0) throw new Error('ffmpeg could not decode a sound:\n' + r.stderr);
  const raw = r.stdout;
  if (!raw || raw.length < 4) throw new Error('ffmpeg decoded 0 samples (broken res.dat?)');
  // primero se copia: un Buffer puede empezar en un offset impar y un Int16Array no lo acepta
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

// sounds:     buffers { kick, goal, crowd } que vienen de loadAssets
// kicks:      tiempos de patada en segundos, relativos al inicio del clip
// goalT:      tiempo del gol en segundos (o null)
// crowdGains: ganancia del público por tick desde el inicio del clip (ver crowd.js), o null
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
      const g = crowdGains[k0] + (crowdGains[k1] - crowdGains[k0]) * (k - k0); // lerp para que no haya escalones de 60 Hz
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
