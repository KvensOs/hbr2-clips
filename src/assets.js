'use strict';

// Loads what we need from res.dat, the zip the HaxBall client downloads when you open
// haxball.com/play (Network tab). It's HaxBall's stuff so it is not in the repo, put your own
// copy in assets/res.dat.
const fs = require('fs');
const AdmZip = require('adm-zip');
const { loadImage } = require('canvas');

const IMAGES = { grass: 'images/grass.png', concrete: 'images/concrete.png', concrete2: 'images/concrete2.png', typing: 'images/typing.png' };
const SOUNDS = ['kick', 'goal', 'crowd'];
// depending on the client version the sounds are .wav or .ogg, ffmpeg reads both
const EXTS = ['wav', 'ogg'];

async function loadAssets(resDatPath) {
  if (!fs.existsSync(resDatPath)) {
    throw new Error(`${resDatPath} not found. Get res.dat from the HaxBall client and put it there (see README).`);
  }
  const zip = new AdmZip(resDatPath);
  const get = (name) => {
    const e = zip.getEntry(name);
    if (!e) throw new Error(`res.dat has no ${name}`);
    return e.getData();
  };
  const images = {};
  for (const [k, file] of Object.entries(IMAGES)) images[k] = await loadImage(get(file));
  const sounds = {};
  for (const k of SOUNDS) {
    const ext = EXTS.find((e) => zip.getEntry(`sounds/${k}.${e}`));
    if (!ext) throw new Error(`res.dat has no sounds/${k}.wav or sounds/${k}.ogg`);
    sounds[k] = get(`sounds/${k}.${ext}`);
  }
  return { images, sounds };
}

module.exports = { loadAssets };
