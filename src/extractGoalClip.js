'use strict';

// Renders a video clip of every goal in a .hbr2 replay, using node-haxball's renderer and the
// game's own sounds.
//
//   node src/extractGoalClip.js replay.hbr2 [--goal 2] [--before 5] [--after 2] [--fps 30]
//                                           [--zoom 1.6] [--size 1280x720] [--format gif]
//                                           [--camera ball] [--no-sound] [--no-overlays]
//
// Goals are read from the replay's own index (hbr2Index), then a single pass over the replay
// draws the frames inside each goal window. A clip is encoded with ffmpeg as soon as its
// window is over, while the pass keeps going.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installDomShim } = require('./domShim');
const { loadAssets } = require('./assets');
const { createOfficialRenderer } = require('./officialRenderer');
const { buildTrack } = require('./audio');
const { encodeClip } = require('./framesToVideo');
const { readGoalIndex } = require('./hbr2Index');
const { CrowdModel, readDanger, CELEBRATION_TICKS } = require('./crowd');

const TICK_RATE = 60;
const CROWD_LEAD_TICKS = 5 * TICK_RATE; // start the crowd model this early before a window
const MAX_ENCODERS = 2;

const DEFAULTS = {
  width: 960, height: 540, zoom: 1.5,
  fps: 60,           // 60 = one frame per tick. Rounded to a divisor of 60 (60, 30, 20, 15...)
  preS: 5, postS: 2, // seconds before / after the goal
  format: 'mp4',     // 'mp4' or 'gif' (gif has no audio and tops out at 30 fps)
  gifWidth: 640,     // gif output width, the frames are scaled down to it
  camera: 'game',    // 'game' = the game's own follow, 'ball' = tight follow (see smooth)
  smooth: 0.2,       // camera 'ball': fraction of the way to the ball per tick, 1 = locked on it
  warmupTicks: 60,   // drawn but not saved, lets the camera settle
  speed: 60,         // replay playback speed, doesn't change the output
  sound: true, crowd: true, overlays: true,
  onlyGoal: null,
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

// returns [{ index, tick, teamId }], teamId = team that scored
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

// sparse[from..to] with holes filled by the previous value
function denseGains(sparse, from, to) {
  const out = [];
  let last = 0;
  for (let i = from; i <= to; i++) { if (sparse[i] !== undefined) last = sparse[i]; out.push(last); }
  return out;
}

async function renderClips({ API, data, goals, totalGoals, opts, assets, domShim, outDir }) {
  const stride = Math.max(1, Math.round(TICK_RATE / opts.fps));
  const fps = TICK_RATE / stride; // the real frame rate, since we draw one frame every `stride` ticks
  const dtMs = (stride / TICK_RATE) * 1000;
  const withAudio = opts.sound && opts.format === 'mp4';
  const gifWidth = opts.gifWidth && opts.width > opts.gifWidth ? opts.gifWidth : null;
  const R = createOfficialRenderer({
    API, domShim, images: assets.images, width: opts.width, height: opts.height, zoom: opts.zoom, overlays: opts.overlays,
    camera: opts.camera, smooth: opts.smooth, ticksPerFrame: stride,
  });
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hbr2clips-')); // temp frames, out of OneDrive

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
    jobs.push(limit(async () => {
      await encodeClip({ framesDir: w.dir, outFile, fps, audioPath, gif: opts.format === 'gif' ? { width: gifWidth } : null });
      console.log(`${path.basename(outFile)}  ${g.scorer ?? '?'}  ${g.red}-${g.blue}`);
      results.push({ file: outFile, frames: w.frames, ...g });
    }).catch((e) => { failures.push(`goal_${w.index}: ${e.message}`); }));
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
      // goal number N in the replay is goal number N in the index, so match by order
      const seq = ++goalSeq;
      const w = windows.find((x) => x.index === seq);
      if (w) {
        if (Math.abs(tick - w.expectTick) > 2) console.warn(`goal_${w.index}: index says tick ${w.expectTick}, replay says ${tick}`);
        w.info = {
          index: w.index, tick, teamId,
          scorer: shooter?.name ?? null, // last player to touch the ball
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

      // crowd model runs every tick near the windows
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
          if (t < w.start) continue; // warmup
          if (w.firstTick == null) w.firstTick = t;
          fs.writeFileSync(path.join(w.dir, `frame_${String(w.frames++).padStart(5, '0')}.png`), png);
        }
      }

      for (const w of windows) if (!w.done && t > w.end) finalize(w);
    },
  }), opts.speed);

  // goals close to the end of the replay
  for (const w of windows) if (!w.done) finalize(w);
  if (goalSeq !== totalGoals) console.warn(`index has ${totalGoals} goals but the replay fired ${goalSeq}`);

  await Promise.all(jobs);
  fs.rmSync(tmpRoot, { recursive: true, force: true });

  if (failures.length) throw new Error('some clips failed:\n  ' + failures.join('\n  '));
  return results.sort((a, b) => a.index - b.index);
}

// returns one { file, frames, index, tick, teamId, scorer, ownGoal, red, blue, timeS } per goal
async function extractGoalClips(replayPath, outDir, options = {}) {
  const given = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined));
  const opts = { ...DEFAULTS, ...given };
  if (!['mp4', 'gif'].includes(opts.format)) throw new Error(`unknown format "${opts.format}", use mp4 or gif`);
  if (!['game', 'ball'].includes(opts.camera)) throw new Error(`unknown camera "${opts.camera}", use game or ball`);
  if (!(opts.smooth > 0 && opts.smooth <= 1)) throw new Error('smooth has to be a number above 0 and up to 1');
  if (!(opts.preS >= 0 && opts.postS >= 0)) throw new Error('before / after have to be zero or more seconds');
  if (!(opts.fps > 0)) throw new Error('fps has to be a positive number');
  if (opts.format === 'gif') opts.fps = Math.min(opts.fps, 30);
  const domShim = installDomShim(); // has to happen before the renderer is created
  const API = require('node-haxball')();

  // exact-size copy: a Node Buffer can be a slice of a bigger pool and node-haxball
  // would read pool garbage as part of the .hbr2 header
  const data = new Uint8Array(fs.readFileSync(replayPath));

  const goals = await findGoals(API, data, opts.speed);
  const chosen = opts.onlyGoal ? goals.filter((g) => g.index === opts.onlyGoal) : goals;
  if (!chosen.length) return [];

  const assets = await loadAssets(opts.resDat);
  return renderClips({ API, data, goals: chosen, totalGoals: goals.length, opts, assets, domShim, outDir });
}

function parseArgs(argv) {
  const o = {}; let replay = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--goal') o.onlyGoal = Number(argv[++i]);
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
    else if (a === '--no-overlays') o.overlays = false;
    else replay = a;
  }
  return { replay, options: o };
}

if (require.main === module) {
  const { replay, options } = parseArgs(process.argv.slice(2));
  if (!replay) {
    console.error('usage: node src/extractGoalClip.js replay.hbr2 [--goal N] [--before S] [--after S] [--fps 30] [--zoom 1.6]\n' +
      '       [--size 1280x720] [--format mp4|gif] [--gif-width 640] [--camera game|ball] [--smooth 0.2] [--no-sound] [--no-overlays]');
    process.exit(1);
  }
  const outDir = path.join(__dirname, '..', 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const t0 = Date.now();
  extractGoalClips(replay, outDir, options).then((r) => {
    console.log(r.length ? `${r.length} clip(s) in ${((Date.now() - t0) / 1000).toFixed(1)} s -> ${outDir}` : 'no goals in this replay');
  }).catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { extractGoalClips };
