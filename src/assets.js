'use strict';

// Carga lo que necesitamos de res.dat, el zip que descarga el cliente de HaxBall al abrir
// haxball.com/play (pestaña Network). Es contenido de HaxBall, así que no está en el repo;
// poné tu propia copia en assets/res.dat.
const fs = require('fs');
const AdmZip = require('adm-zip');
const { loadImage } = require('canvas');

const IMAGES = { grass: 'images/grass.png', concrete: 'images/concrete.png', concrete2: 'images/concrete2.png', typing: 'images/typing.png' };
const SOUNDS = ['kick', 'goal', 'crowd'];
// según la versión del cliente los sonidos son .wav o .ogg, ffmpeg lee los dos
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
