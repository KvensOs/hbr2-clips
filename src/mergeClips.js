'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { FFMPEG_PATH } = require('./framesToVideo');

// Une clips en un solo mp4, en el orden dado. Todos los clips ya deben compartir el mismo
// códec/resolución/fps (así sale todo lo que produce encodeClip en este proyecto), lo que le
// permite al demuxer concat de ffmpeg copiar los streams en vez de recodificar (rápido, sin
// pérdida de calidad).
function mergeClips(files, outFile) {
  return new Promise((resolve, reject) => {
    if (!files.length) return reject(new Error('no clips to merge'));
    const listFile = path.join(os.tmpdir(), `hbr2clips-merge-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    const listBody = files.map((f) => `file '${path.resolve(f).replace(/'/g, "'\\''")}'`).join('\n');
    fs.writeFileSync(listFile, listBody);

    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', outFile];
    const p = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    p.on('error', (e) => { fs.rmSync(listFile, { force: true }); reject(new Error('could not run ffmpeg: ' + e.message)); });
    p.on('close', (code) => {
      fs.rmSync(listFile, { force: true });
      if (code !== 0) return reject(new Error('ffmpeg merge failed:\n' + err));
      resolve(outFile);
    });
  });
}

module.exports = { mergeClips };
