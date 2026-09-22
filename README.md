# hbr2-clips

![Node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)
![ffmpeg](https://img.shields.io/badge/ffmpeg-incluido-informational)
![Licencia](https://img.shields.io/badge/licencia-ISC-blue)

Renderiza clips mp4 (o gif) de los goles de una repetición de HaxBall (`.hbr2`), usando el
propio renderer y los sonidos del juego. También puede juntar todos los goles en un solo video.

Tres formas de usarlo, según lo que necesites:

1. **CLI** — para probarlo o correrlo manualmente.
2. **Librería** — para tu propio bot de Discord u otro proyecto de Node.
3. **API HTTP** — para una página web, un bot en un panel de hosting sin terminal (Pterodactyl,
   Apollo, etc.), o cualquier cliente que no sea Node.

**Índice:** [Requisitos](#requisitos) · [CLI](#1-uso-por-línea-de-comandos) ·
[Librería](#2-como-librería-bot-propio-script-etc) · [API HTTP](#3-api-http-página-web-bot-en-hosting-sin-terminal-cualquier-lenguaje) ·
[Opciones de render](#opciones-de-render) · [Notas](#notas) · [Licencia](#licencia)

---

## Requisitos

- Node.js 18 o superior.
- `assets/res.dat`: el zip que descarga el cliente de HaxBall al abrir haxball.com/play (pestaña
  Network del navegador). Es contenido de HaxBall, así que no viene incluido en el repo — cada
  quien pone su propia copia en `assets/res.dat`.
- **ffmpeg no hay que instalarlo aparte.** Viene incluido como dependencia de npm
  (`ffmpeg-static`), así que funciona en Windows, Linux, Mac, y también en paneles de hosting
  para bots (Pterodactyl/Apollo y similares) donde solo tienes `npm install` / `npm start` y no
  una terminal real. Si preferís usar tu propio ffmpeg del sistema, definí la variable de
  entorno `FFMPEG_PATH` con la ruta al binario.

```bash
npm install
```

---

## 1. Uso por línea de comandos

```bash
node src/extractGoalClip.js replay.hbr2 [--goal N | --goal 1,2,3] [--merge] [--before S] [--after S]
                                          [--fps 30] [--zoom 1.6] [--size 1280x720]
                                          [--format mp4|gif] [--gif-width 640] [--camera game|ball]
                                          [--smooth 0.2] [--no-sound] [--no-overlays] [--res ruta.dat]
```

Sin `--goal`, renderiza todos los goles del replay. Los clips salen en `out/` (más el video
combinado, `out/all.mp4`, si pasás `--merge`). El detalle de cada flag está en la
[tabla de opciones](#opciones-de-render) más abajo.

---

## 2. Como librería (bot propio, script, etc.)

```js
const { extractGoalClips, readGoalIndex } = require('hbr2-clips'); // o require('./hbr2-clips') si lo copiaste sin publicarlo a npm
const fs = require('fs');

// Listar los goles sin renderizar nada (rápido, útil para mostrar un menú de selección)
const { goals } = readGoalIndex(fs.readFileSync('replay.hbr2'));

// Renderizar
const clips = await extractGoalClips('replay.hbr2', './out', {
  onlyGoal: [1, 2],   // opcional: null = todos, número = uno, array = varios
  merge: true,        // opcional: añade clips.merged con la ruta del video combinado
  format: 'mp4',
});

console.log(clips);        // [{ file, index, scorer, red, blue, timeS, ... }, ...]
console.log(clips.merged); // ruta de all.mp4, si merge:true y hay más de un gol
```

Ejemplo típico para un bot de Discord: al recibir el `.hbr2` (adjunto de un mensaje), lo guardás
a disco, llamás `extractGoalClips`, y subís `clips[i].file` o `clips.merged` como adjunto de la
respuesta.

Usando la librería directo tenés además `resDat` por si querés apuntar a un `res.dat` distinto
por llamada — es la única opción que sigue siendo exclusiva de este modo, porque tiene más
sentido como configuración del servidor que como parámetro por pedido.

---

## 3. API HTTP (página web, bot en hosting sin terminal, cualquier lenguaje)

```bash
npm start          # arranca en el puerto 3000 (configurable con PORT)
```

Variables de entorno opcionales: `PORT`, `DATA_DIR` (dónde guarda archivos temporales),
`MAX_UPLOAD_MB` (default 50), `MAX_CONCURRENT_RENDERS` (default 2 — cuántos renders corren a la
vez; súbelo solo si el servidor tiene CPU de sobra), `MAX_AGE_MINUTES` (default 120 — cada cuánto
se borran replays/renders viejos), `CORS_ORIGIN` (default `*`, poné el dominio de tu web en
producción).

### Endpoints

| Método | Ruta | Qué hace |
|:---:|---|---|
| `GET` | `/health` | chequeo simple, devuelve `{ ok: true }` |
| `POST` | `/api/replays` | sube un `.hbr2` (campo multipart `replay`) y devuelve su lista de goles |
| `GET` | `/api/replays/:id` | vuelve a consultar un replay ya subido |
| `POST` | `/api/replays/:id/render` | encola el render de algunos o todos los goles |
| `GET` | `/api/jobs/:id` | consulta el progreso y las URLs de descarga de un render |
| `GET` | `/files/:jobId/:filename` | descarga un archivo ya renderizado |
| `DELETE` | `/api/replays/:id` | borra un replay subido antes de que expire solo |

### Flujo

**a) Subir el replay y listar sus goles** (sin renderizar nada todavía):

```bash
curl -F "replay=@replay.hbr2" http://localhost:3000/api/replays
# { "replayId": "abc123", "totalGoals": 3, "goals": [
#     { "index": 1, "timeS": 42, "team": "red" }, ... ] }
```

**b) Pedir el render** de los goles que quieras (o todos, o combinados en un solo video):

```bash
curl -X POST http://localhost:3000/api/replays/abc123/render \
  -H "Content-Type: application/json" \
  -d '{"goals": "all", "merge": true, "format": "mp4"}'
# { "jobId": "xyz789", "status": "processing" }
```

El body acepta las mismas opciones de render que la CLI (ver la tabla de abajo), con los nombres
de la columna "API body" — por ejemplo `before` / `after` para el margen antes y después del gol.

**c) Consultar el estado y descargar** (el render corre en segundo plano, con una cola limitada
para no saturar el servidor si llegan varias peticiones a la vez):

```bash
curl http://localhost:3000/api/jobs/xyz789
# mientras procesa: { "jobId": "xyz789", "status": "processing" }
# al terminar:       { "status": "done",
#                       "files": [{ "index":1, "scorer":"...", "red":1, "blue":0, "url":"http://.../files/xyz789/goal_1.mp4" }, ...],
#                       "mergedUrl": "http://localhost:3000/files/xyz789/all.mp4" }
```

Los archivos se sirven desde la propia API en `mergedUrl` / `files[i].url`; una página web solo
necesita hacer `fetch` a esos tres endpoints, y un bot puede simplemente descargar la URL final y
adjuntarla.

---

## Opciones de render

Válido para los tres modos de uso (CLI, librería y API), aunque no todas las opciones están
expuestas en los tres lugares — la columna correspondiente queda vacía cuando no aplica.

| Qué hace | CLI | Librería / API body | Default |
|---|---|---|---|
| Qué goles renderizar | `--goal N` o `--goal 1,2,3` (repetible) | `onlyGoal` / `goals` | todos |
| Video con todos los goles seguidos | `--merge` | `merge` | `false` |
| Formato de salida | `--format mp4\|gif` | `format` | `mp4` |
| Cuadros por segundo | `--fps N` | `fps` | 60 (se ajusta a un divisor de 60; en gif tope 30) |
| Margen antes del gol | `--before S` | `preS` / `before` | 5 s |
| Margen después del gol | `--after S` | `postS` / `after` | 2 s |
| Tamaño del video | `--size ANCHOxALTO` | `width`+`height` / `size` | `960x540` |
| Zoom de cámara | `--zoom N` | `zoom` | 1.5 |
| Modo de cámara | `--camera game\|ball` | `camera` | `game` (seguimiento propio del juego; `ball` se pega a la pelota) |
| Suavizado de la cámara `ball` | `--smooth N` | `smooth` | 0.2 (fracción de la distancia a la pelota recorrida por tick, 1 = pegada del todo) |
| Ancho del gif | `--gif-width N` | `gifWidth` | 640 |
| Sonido | `--no-sound` | `sound` | `true` |
| Marcador y "¡Gol!" en pantalla | `--no-overlays` | `overlays` | `true` |
| Ambiente de público de fondo | `--no-crowd` | `crowd` | `true` |
| `res.dat` alternativo | `--res ruta` | `resDat` *(solo librería)* | `assets/res.dat` |

---

## Notas

- Los replays y renders subidos se guardan solo en memoria/disco temporal y se borran solos
  pasado `MAX_AGE_MINUTES` — no hay que limpiar nada a mano.
- No hay autenticación por defecto. Si vas a exponer la API fuera de tu red local, ponele algo
  delante (proxy con API key, o agregá tu propio middleware de auth en `server/index.js`).

---

## Licencia

ISC, ver [LICENSE](LICENSE). El contenido de `res.dat` (imágenes/sonidos del juego) sigue siendo
de HaxBall, no de este proyecto.
