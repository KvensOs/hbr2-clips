'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

// Encodes framesDir/frame_00000.png, frame_00001.png... with ffmpeg (has to be in PATH).
// Deletes framesDir when done.
//
// mp4 (default): H.264 High + yuv420p. If audioPath is given the wav goes into the same ffmpeg
// run as AAC-LC stereo 48 kHz. The pan filter just copies the mono channel to both sides (a
// plain -ac 2 would drop the level by 3 dB).
// gif: pass gif = { width }. Two-step palette in one run; width null keeps the frame size.
function encodeClip({ framesDir, outFile, fps, audioPath = null, gif = null }) {
  return new Promise((resolve, reject) => {
    if (audioPath && !fs.existsSync(audioPath)) return reject(new Error('audio file not found: ' + audioPath));

    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-framerate', String(fps), '-i', path.join(framesDir, 'frame_%05d.png')];
    if (gif) {
      const scale = gif.width ? `scale=${gif.width}:-1:flags=lanczos,` : '';
      args.push('-filter_complex', `[0:v]${scale}split[a][b];[a]palettegen[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`, '-loop', '0', outFile);
    } else {
      if (audioPath) args.push('-i', audioPath);
      args.push('-map', '0:v:0');
      if (audioPath) args.push('-map', '1:a:0');
      args.push('-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-crf', '18', '-tag:v', 'avc1');
      if (audioPath) args.push('-c:a', 'aac', '-profile:a', 'aac_low', '-af', 'pan=stereo|c0=c0|c1=c0', '-b:a', '160k', '-ar', '48000', '-shortest');
      args.push('-movflags', '+faststart', outFile);
    }

    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    p.on('error', (e) => reject(new Error('could not run ffmpeg: ' + e.message)));
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error('ffmpeg failed:\n' + err));
      if (audioPath && !hasAudio(outFile)) return reject(new Error('mp4 came out without an audio track: ' + outFile));
      fs.rmSync(framesDir, { recursive: true, force: true });
      resolve(outFile);
    });
  });
}

function hasAudio(file) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-i', file], { encoding: 'utf8' });
  return /Stream #\d+:\d+.*Audio:/.test(r.stderr || '');
}

module.exports = { encodeClip };
