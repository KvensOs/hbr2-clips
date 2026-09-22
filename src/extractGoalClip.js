'use strict';

// Renderiza un clip de video de cada gol en un replay .hbr2, usando el renderer y los sonidos
// del propio juego.
//
//   node src/extractGoalClip.js replay.hbr2 [--goal 2] [--before 5] [--after 2] [--fps 30]
//                                           [--zoom 1.6] [--size 1280x720] [--format gif]
//                                           [--camera ball] [--no-sound] [--no-crowd] [--no-overlays]
//
// Los goles se leen del índice propio del replay (hbr2Index), y después se hace una sola
// pasada sobre el replay dibujando los frames dentro de cada ventana de gol. Un clip se
// codifica con ffmpeg apenas termina su ventana, mientras la pasada sigue corriendo.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installDomShim } = require('./domShim');
const { loadAssets } = require('./assets');
const { createOfficialRenderer } = require('./officialRenderer');
const { buildTrack } = require('./audio');
const { encodeClip } = require('./framesToVideo');
const { mergeClips } = require('./mergeClips');
const { readGoalIndex } = require('./hbr2Index');
const { CrowdModel, readDanger, CELEBRATION_TICKS } = require('./crowd');

const TICK_RATE = 60;
const CROWD_LEAD_TICKS = 5 * TICK_RATE; // arrancar el modelo de público este rato antes de una ventana
const MAX_ENCODERS = 2;

const DEFAULTS = {
  width: 960, height: 540, zoom: 1.5,
  fps: 60,           // 60 = un frame por tick. Se redondea a un divisor de 60 (60, 30, 20, 15...)
  preS: 5, postS: 2, // segundos antes / después del gol
  format: 'mp4',     // 'mp4' o 'gif' (el gif no tiene audio y tope de 30 fps)
  gifWidth: 640,     // ancho de salida del gif, los frames se escalan a eso
  camera: 'game',    // 'game' = el seguimiento propio del juego, 'ball' = seguimiento ajustado (ver smooth)
  smooth: 0.2,       // cámara 'ball': fracción del camino hacia la pelota por tick, 1 = pegada a ella
  warmupTicks: 60,   // se dibujan pero no se guardan, para que la cámara se asiente
  speed: 60,         // velocidad de reproducción del replay, no cambia la salida
  sound: true, crowd: true, overlays: true,
  onlyGoal: null,   // null = todos los goles, un número = solo ese, un array = solo esos
  merge: false,     // también genera un video con todos los goles renderizados uno atrás del otro (solo mp4)
  resDat: path.join(__dirname, '..', 'assets', 'res.dat'),
};

function play(API, data, handlers, speed) {
  return new Promise((resolve) => {
    const ctx = {};
    ctx.reader = API.Replay.read(data, handlers(ctx));
    ctx.reader.onEnd = () => { ctx.reader.destroy(); resolve(); };
    ctx.reader.setSpeed(speed);
  });
}

// devuelve [{ index, tick, teamId }], teamId = equipo que convirtió
async function findGoals(API, data, speed) {
  try {
    return readGoalIndex(data).goals;
  } catch (e) {
    console.warn(`could not read the replay index (${e.message}), scanning the whole replay`);
    const goals = [];
    await play(API, data, (ctx) => ({
      onTeamGoal: (teamId) => goals.push({ index: goals.length + 1, tick: ctx.reader.getCurrentFrameNo(), teamId }),
    }), speed);
    return goals;
  }
}

function createLimiter(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

// sparse[from..to] con los huecos rellenados con el último valor
function denseGains(sparse, from, to) {
  const out = [];
  let last = 0;
  for (let i = from; i <= to; i++) { if (sparse[i] !== undefined) last = sparse[i]; out.push(last); }
  return out;
}

async function renderClips({ API, data, goals, totalGoals, opts, assets, domShim, outDir }) {
  const stride = Math.max(1, Math.round(TICK_RATE / opts.fps));
  const fps = TICK_RATE / stride; // el frame rate real, ya que dibujamos un frame cada `stride` ticks
  const dtMs = (stride / TICK_RATE) * 1000;
  const withAudio = opts.sound && opts.format === 'mp4';
  const gifWidth = opts.gifWidth && opts.width > opts.gifWidth ? opts.gifWidth : null;
  const R = createOfficialRenderer({
    API, domShim, images: assets.images, width: opts.width, height: opts.height, zoom: opts.zoom, overlays: opts.overlays,
    camera: opts.camera, smooth: opts.smooth, ticksPerFrame: stride,
  });
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hbr2clips-')); // frames temporales, fuera de OneDrive

  const windows = goals.map((g) => {
    const start = Math.max(0, g.tick - opts.preS * TICK_RATE);
    const w = {
      index: g.index, expectTick: g.tick, start, from: Math.max(0, start - opts.warmupTicks), end: g.tick + opts.postS * TICK_RATE,
      dir: path.join(tmpRoot, `goal_${g.index}`), frames: 0, firstTick: null, crowd: [], info: null, done: false,
    };
    fs.mkdirSync(w.dir, { recursive: true });
    return w;
  });
  let pending = windows.length;
  const inAnyWindow = (t) => windows.some((w) => !w.done && t >= w.from && t <= w.end);
  const needCrowd = (t) => windows.some((w) => !w.done && t >= w.from - CROWD_LEAD_TICKS && t <= w.end);

  const kicks = [];
  let lastKick = null, goalSeq = 0, celebrateUntil = -1, dangerOk = true;
  const crowd = new CrowdModel();
  const limit = createLimiter(MAX_ENCODERS);
  const jobs = [], results = [], failures = [];

  const finalize = (w) => {
    w.done = true; pending--;
    const g = w.info;
    if (!g || !w.frames) {
      console.warn(`goal_${w.index}: ${!g ? 'the replay never fired this goal' : 'no frames'}, skipping`);
      fs.rmSync(w.dir, { recursive: true, force: true });
      return;
    }
    const outFile = path.join(outDir, `goal_${w.index}.${opts.format}`);
    let audioPath = null;
    if (withAudio) {
      const t0 = w.firstTick;
      const workDir = path.join(outDir, 'work', `goal_${w.index}`);
      fs.mkdirSync(workDir, { recursive: true });
      audioPath = buildTrack({
        sounds: assets.sounds,
        durationS: w.frames / fps,
        kicks: kicks.filter((k) => k >= t0 && k <= w.end).map((k) => (k - t0) / TICK_RATE),
        goalT: (g.tick - t0) / TICK_RATE,
        crowdGains: opts.crowd ? denseGains(w.crowd, t0 - w.start, w.crowd.length - 1) : null,
        gainsPerS: TICK_RATE,
        outPath: path.join(workDir, 'audio.wav'),
      });
    }
    const workDir = audioPath ? path.dirname(audioPath) : null;
    jobs.push(limit(async () => {
      await encodeClip({ framesDir: w.dir, outFile, fps, audioPath, gif: opts.format === 'gif' ? { width: gifWidth } : null });
      console.log(`${path.basename(outFile)}  ${g.scorer ?? '?'}  ${g.red}-${g.blue}`);
      results.push({ file: outFile, frames: w.frames, ...g });
    }).catch((e) => { failures.push(`goal_${w.index}: ${e.message}`); })
      .finally(() => { if (workDir) fs.rmSync(workDir, { recursive: true, force: true }); }));
  };

  await play(API, data, (ctx) => ({
    onGameStart: (...a) => { if (inAnyWindow(ctx.reader.getCurrentFrameNo())) R.onGameStart(...a); },

    onPlayerBallKick: (id) => {
      lastKick = { tick: ctx.reader.getCurrentFrameNo(), id };
      kicks.push(lastKick.tick);
    },

    onTeamGoal: (...a) => {
      const teamId = a[0], tick = ctx.reader.getCurrentFrameNo();
      const st = ctx.reader.state, gs = st.gameState;
      const shooter = lastKick ? st.getPlayer(lastKick.id) : null;
      celebrateUntil = tick + CELEBRATION_TICKS;
      // el gol número N del replay es el gol número N del índice, así que empatan por orden
      const seq = ++goalSeq;
      const w = windows.find((x) => x.index === seq);
      if (w) {
        if (Math.abs(tick - w.expectTick) > 2) console.warn(`goal_${w.index}: index says tick ${w.expectTick}, replay says ${tick}`);
        w.info = {
          index: w.index, tick, teamId,
          scorer: shooter?.name ?? null, // último jugador en tocar la pelota
          ownGoal: shooter ? shooter.team.id !== teamId : false,
          red: gs.redScore, blue: gs.blueScore,
          timeS: Math.round(gs.timeElapsed),
        };
      }
      if (inAnyWindow(tick)) R.onTeamGoal(...a);
    },

    onGameTick: () => {
      if (!pending) return;
      const t = ctx.reader.getCurrentFrameNo();
      const st = ctx.reader.state;
      if (!st.gameState) return;

      // el modelo de público corre cada tick cerca de las ventanas
      let gain = 0;
      if (withAudio && opts.crowd) {
        if (needCrowd(t)) {
          let danger = false;
          if (dangerOk) {
            try { danger = readDanger(st); } catch (e) {
              dangerOk = false;
              console.warn(`could not read player positions for the crowd (${e.message}), only the goal crowd will play`);
            }
          }
          gain = crowd.step({ celebrating: t < celebrateUntil, danger });
        } else crowd.reset();
      }

      const active = windows.filter((w) => !w.done && t >= w.from && t <= w.end);
      for (const w of active) if (t >= w.start) w.crowd[t - w.start] = gain;

      if (active.length && t % stride === 0) {
        const png = R.render(st, dtMs, t);
        for (const w of active) {
          if (t < w.start) continue; // calentamiento de cámara
          if (w.firstTick == null) w.firstTick = t;
          fs.writeFileSync(path.join(w.dir, `frame_${String(w.frames++).padStart(5, '0')}.png`), png);
        }
      }

      for (const w of windows) if (!w.done && t > w.end) finalize(w);
    },
  }), opts.speed);

  // goles cerca del final del replay
  for (const w of windows) if (!w.done) finalize(w);
  if (goalSeq !== totalGoals) console.warn(`index has ${totalGoals} goals but the replay fired ${goalSeq}`);

  await Promise.all(jobs);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(path.join(outDir, 'work'), { recursive: true, force: true }); // cada goal_N ya se limpió solo, esto borra el padre ya vacío

  if (failures.length) throw new Error('some clips failed:\n  ' + failures.join('\n  '));
  return results.sort((a, b) => a.index - b.index);
}

// devuelve un { file, frames, index, tick, teamId, scorer, ownGoal, red, blue, timeS } por gol
async function extractGoalClips(replayPath, outDir, options = {}) {
  const given = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined));
  const opts = { ...DEFAULTS, ...given };
  if (!['mp4', 'gif'].includes(opts.format)) throw new Error(`unknown format "${opts.format}", use mp4 or gif`);
  if (!['game', 'ball'].includes(opts.camera)) throw new Error(`unknown camera "${opts.camera}", use game or ball`);
  if (!(opts.smooth > 0 && opts.smooth <= 1)) throw new Error('smooth has to be a number above 0 and up to 1');
  if (!(opts.preS >= 0 && opts.postS >= 0)) throw new Error('before / after have to be zero or more seconds');
  if (!(opts.fps > 0)) throw new Error('fps has to be a positive number');
  if (opts.format === 'gif') opts.fps = Math.min(opts.fps, 30);
  const domShim = installDomShim(); // tiene que pasar antes de crear el renderer
  const API = require('node-haxball')();

  // copia de tamaño exacto: un Buffer de Node puede ser un slice de un pool más grande, y
  // node-haxball leería basura del pool como parte del header del .hbr2
  const data = new Uint8Array(fs.readFileSync(replayPath));

  const goals = await findGoals(API, data, opts.speed);
  const wanted = opts.onlyGoal == null ? null : [].concat(opts.onlyGoal).map(Number);
  const chosen = wanted ? goals.filter((g) => wanted.includes(g.index)) : goals;
  if (!chosen.length) return [];

  const assets = await loadAssets(opts.resDat);
  const results = await renderClips({ API, data, goals: chosen, totalGoals: goals.length, opts, assets, domShim, outDir });

  // results sigue siendo un array plano (así `.length` / `.map()` etc. siguen funcionando para
  // los que ya la llaman) con la ruta del video mergeado colgada como una propiedad extra, sin
  // romper la enumerabilidad.
  if (opts.merge && results.length > 1) {
    if (opts.format !== 'mp4') {
      console.warn('merge only works with --format mp4, skipping');
    } else {
      const mergedFile = path.join(outDir, 'all.mp4');
      await mergeClips(results.map((r) => r.file), mergedFile);
      results.merged = mergedFile;
    }
  } else if (opts.merge && results.length === 1) {
    results.merged = results[0].file; // no hay nada que unir, el único clip ya es "el video"
  }
  return results;
}

function parseArgs(argv) {
  const o = {}; let replay = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--goal') {
      const nums = argv[++i].split(',').map(Number);
      o.onlyGoal = o.onlyGoal ? o.onlyGoal.concat(nums) : nums; // --goal se puede repetir o recibir "1,3,4"
    }
    else if (a === '--merge') o.merge = true;
    else if (a === '--fps') o.fps = Number(argv[++i]);
    else if (a === '--before') o.preS = Number(argv[++i]);
    else if (a === '--after') o.postS = Number(argv[++i]);
    else if (a === '--format') o.format = argv[++i];
    else if (a === '--gif-width') o.gifWidth = Number(argv[++i]);
    else if (a === '--camera') o.camera = argv[++i];
    else if (a === '--smooth') o.smooth = Number(argv[++i]);
    else if (a === '--zoom') o.zoom = Number(argv[++i]);
    else if (a === '--size') { const [w, h] = argv[++i].split('x').map(Number); o.width = w; o.height = h; }
    else if (a === '--res') o.resDat = argv[++i];
    else if (a === '--no-sound') o.sound = false;
    else if (a === '--no-crowd') o.crowd = false;
    else if (a === '--no-overlays') o.overlays = false;
    else replay = a;
  }
  return { replay, options: o };
}

if (require.main === module) {
  const { replay, options } = parseArgs(process.argv.slice(2));
  if (!replay) {
    console.error('usage: node src/extractGoalClip.js replay.hbr2 [--goal N | --goal 1,2,3] [--merge] [--before S] [--after S]\n' +
      '       [--fps 30] [--zoom 1.6] [--size 1280x720] [--format mp4|gif] [--gif-width 640] [--camera game|ball]\n' +
      '       [--smooth 0.2] [--no-sound] [--no-crowd] [--no-overlays]');
    process.exit(1);
  }
  const outDir = path.join(__dirname, '..', 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const t0 = Date.now();
  extractGoalClips(replay, outDir, options).then((r) => {
    if (!r.length) return console.log(options.onlyGoal ? 'none of the requested --goal numbers exist in this replay' : 'no goals in this replay');
    console.log(`${r.length} clip(s) in ${((Date.now() - t0) / 1000).toFixed(1)} s -> ${outDir}`);
    if (r.merged) console.log(`merged -> ${r.merged}`);
  }).catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { extractGoalClips, readGoalIndex };
