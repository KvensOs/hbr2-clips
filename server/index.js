'use strict';

try { require('dotenv').config(); } catch { /* .env es opcional: si no está instalado dotenv, simplemente no se usa .env */ }

const path = require('path');
const express = require('express');
const multer = require('multer');
const { extractGoalClips, readGoalIndex } = require('../src/extractGoalClip');
const { createLimiter } = require('./limiter');
const store = require('./store');

const PORT = Number(process.env.PORT || 3000);
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 50);
const MAX_CONCURRENT_RENDERS = Number(process.env.MAX_CONCURRENT_RENDERS || 2);
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*'; // en producción, poné el origen de tu sitio

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 } });
const limit = createLimiter(MAX_CONCURRENT_RENDERS);
store.startCleanup();

const app = express();
app.use(express.json());
app.use((req, res, next) => { // CORS mínimo para que una página en otro origen pueda llamar esto
  res.header('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const TICK_RATE = 60;
const teamName = (id) => (id === 1 ? 'red' : id === 2 ? 'blue' : null);
const publicGoal = (g) => ({ index: g.index, timeS: Math.round(g.tick / TICK_RATE), team: teamName(g.teamId) });
const fileUrl = (req, jobId, filePath) => `${req.protocol}://${req.get('host')}/files/${jobId}/${path.basename(filePath)}`;

app.get('/health', (req, res) => res.json({ ok: true }));

// 1) Subís un .hbr2 y te devuelve la lista de goles al instante, sin renderizar nada.
//    Le permite a una web mostrar "Gol 1 - 12' - red" etc. antes de gastar CPU en renderizar.
app.post('/api/replays', upload.single('replay'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'send the replay as multipart field "replay"' });
  let idx;
  try { idx = readGoalIndex(new Uint8Array(req.file.buffer)); }
  catch (e) { return res.status(400).json({ error: `not a valid .hbr2 replay: ${e.message}` }); }

  const replayId = store.addReplay(req.file.buffer, idx.goals, idx.goals.length);
  res.json({ replayId, totalGoals: idx.goals.length, goals: idx.goals.map(publicGoal) });
});

app.get('/api/replays/:id', (req, res) => {
  const r = store.replays.get(req.params.id);
  if (!r) return res.status(404).json({ error: 'replay not found (it may have expired)' });
  res.json({ replayId: r.id, totalGoals: r.totalGoals, goals: r.goals.map(publicGoal) });
});

// 2) Renderiza algunos (o todos) los goles de ese replay. Corre en segundo plano a través de
//    una cola con concurrencia limitada; consultá GET /api/jobs/:id para ver el progreso y los
//    links de descarga.
//    Body: { goals: "all" | [1,2,3], merge: false, format: "mp4", fps, zoom, camera, size,
//            before, after, sound, crowd, overlays, smooth, gifWidth }
app.post('/api/replays/:id/render', (req, res) => {
  const replay = store.replays.get(req.params.id);
  if (!replay) return res.status(404).json({ error: 'replay not found (it may have expired)' });

  const b = req.body || {};
  const options = {
    onlyGoal: !b.goals || b.goals === 'all' ? null : [].concat(b.goals).map(Number),
    merge: !!b.merge,
    format: b.format,
    fps: b.fps, zoom: b.zoom, camera: b.camera, smooth: b.smooth,
    preS: b.before, postS: b.after,
    sound: b.sound, crowd: b.crowd, overlays: b.overlays,
    gifWidth: b.gifWidth,
  };
  if (typeof b.size === 'string' && /^\d+x\d+$/.test(b.size)) {
    [options.width, options.height] = b.size.split('x').map(Number);
  }

  const jobId = store.addJob(replay.id);
  const job = store.jobs.get(jobId);

  limit(() => {
    job.status = 'processing';
    return extractGoalClips(replay.file, job.dir, options);
  }).then((results) => {
    job.status = 'done';
    job.files = results;
    job.merged = results.merged || null;
  }).catch((e) => {
    job.status = 'error';
    job.error = e.message;
  });

  res.status(202).json({ jobId, status: job.status });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = store.jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found (it may have expired)' });
  if (job.status !== 'done') return res.json({ jobId: job.id, status: job.status, error: job.error || undefined });

  res.json({
    jobId: job.id,
    status: 'done',
    files: job.files.map((f) => ({
      index: f.index, scorer: f.scorer, ownGoal: f.ownGoal, red: f.red, blue: f.blue, timeS: f.timeS,
      url: fileUrl(req, job.id, f.file),
    })),
    mergedUrl: job.merged ? fileUrl(req, job.id, job.merged) : null,
  });
});

// 3) Sirve los archivos ya renderizados. Se mantiene como ruta propia (no express.static sobre
//    todo el directorio de datos) para que nada fuera de la carpeta de cada job sea accesible.
app.get('/files/:jobId/:filename', (req, res) => {
  const job = store.jobs.get(req.params.jobId);
  if (!job) return res.status(404).end();
  const safeName = path.basename(req.params.filename); // evita path traversal con ../
  res.sendFile(path.join(job.dir, safeName), (err) => { if (err && !res.headersSent) res.status(404).end(); });
});

app.delete('/api/replays/:id', (req, res) => {
  const r = store.replays.get(req.params.id);
  if (!r) return res.status(404).json({ error: 'replay not found' });
  require('fs').rmSync(r.file, { force: true });
  store.replays.delete(req.params.id);
  res.status(204).end();
});

// Captura errores pasados con next(err) (p. ej. multer rechazando un archivo demasiado grande)
// para que el cliente siempre reciba un JSON de error limpio, en vez de la página HTML con el
// stack trace que muestra Express por defecto.
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `replay is larger than the ${MAX_UPLOAD_MB} MB limit` });
  if (err) return res.status(400).json({ error: err.message || 'bad request' });
  next();
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`hbr2-clips API listening on http://localhost:${PORT}`));
}

module.exports = { app };
