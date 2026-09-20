# hbr2-clips

![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)
![License](https://img.shields.io/badge/license-ISC-blue)

Renders an mp4 clip of every goal in a HaxBall replay (`.hbr2`), using the game's own renderer
and sounds.

The replay is read with [node-haxball](https://github.com/wxyz-abcd/node-haxball) and each goal
is drawn with its port of the game renderer, so the clips show the same pitch, textures,
avatars and camera you see in the client. The audio (kicks, goal, crowd) is built from the
game's own sound files.

## Features

- One clip per goal, from 5 seconds before to 2 seconds after (configurable)
- Same look as the client: pitch textures, team colors, avatars, kick ring, camera easing
- Audio placed at the exact tick of each kick and goal, with the crowd volume following the
  client's own logic (it swells on goals and on dangerous plays)
- H.264 + AAC mp4 that plays anywhere, 60 fps by default (one frame per game tick)
- Scorer, own goal flag, score and match time for every clip, handy for captions

## Requirements

- Node.js 18 or newer
- [ffmpeg](https://ffmpeg.org/) in your `PATH`, with libx264 and aac support
- `assets/res.dat` (see below)

## Installation

```bash
git clone <repository-url>
cd hbr2-clips
npm install
```

`canvas` ships prebuilt binaries for the common platforms. If npm ends up compiling it from
source, follow the [node-canvas install notes](https://github.com/Automattic/node-canvas#compiling).

### res.dat

The textures and sounds come from `res.dat`, the resource archive the HaxBall client downloads
when you open [haxball.com/play](https://www.haxball.com/play). It is HaxBall's own material, so
it is not included in this repository. To get your copy, open the page with the browser dev
tools on the Network tab, reload, find the `res.dat` request and save the file as
`assets/res.dat`.

## Usage

```bash
npm run extract -- path/to/replay.hbr2
```

Clips are written to `out/goal_1.mp4`, `out/goal_2.mp4` and so on. With audio enabled, the
standalone audio tracks are kept in `out/work/goal_N/audio.wav`.

```bash
npm run extract -- replay.hbr2 --goal 2 --fps 30 --size 1280x720 --zoom 1.8
```

| Option | Default | Description |
| --- | --- | --- |
| `--goal N` | all goals | Only render goal number N |
| `--fps N` | `60` | Frames per second. 60 draws every game tick, 30 halves the work |
| `--zoom X` | `1.5` | Camera zoom |
| `--size WxH` | `960x540` | Output resolution |
| `--res path` | `assets/res.dat` | Path to `res.dat` |
| `--no-sound` | | Video only |
| `--no-overlays` | | Hide the "Red Scores!" / "Blue Scores!" text |

`npm run test:sample` renders the sample replay in `samples/`.

## Programmatic use

```js
const { extractGoalClips } = require('./src/extractGoalClip');

const clips = await extractGoalClips('replay.hbr2', 'out', { fps: 30, overlays: false });
```

The output directory has to exist. Options are the same as the CLI flags: `width`, `height`,
`zoom`, `fps`, `preS`, `postS`, `sound`, `crowd`, `overlays`, `onlyGoal` and `resDat`.

It resolves to one object per goal:

| Field | Description |
| --- | --- |
| `file` | Path of the mp4 |
| `frames` | Number of frames in the clip |
| `index` | Goal number in the replay, starting at 1 |
| `tick` | Replay tick of the goal |
| `teamId` | Team that scored, `1` red or `2` blue |
| `scorer` | Nick of the last player to touch the ball |
| `ownGoal` | `true` if that player is on the team that conceded |
| `red`, `blue` | Score right after the goal |
| `timeS` | Match time in seconds |

## How it works

1. **Goals.** A `.hbr2` file stores an index of its goals, so they are read straight from the
   file without simulating anything. If the index can't be read, the replay is scanned instead.
2. **Rendering.** The replay is played once with node-haxball. Inside each goal window, every
   frame is drawn with node-haxball's default renderer on top of node-canvas, through a small
   DOM shim (`src/domShim.js`). The shim's clock is advanced by hand so the camera easing and
   the goal text animate at video speed instead of real time.
3. **Audio.** The kick, goal and crowd sounds from `res.dat` are mixed at the tick of
   each event. The crowd gain is a port of the client's logic (`src/crowd.js`).
4. **Encoding.** As soon as a goal window is over, its frames go to ffmpeg together with the
   audio, while the replay keeps playing. Up to two encodes run at the same time. Frames are
   written to the system temp folder and deleted after each clip.

| File | Purpose |
| --- | --- |
| `src/extractGoalClip.js` | CLI and main pipeline |
| `src/hbr2Index.js` | Reads the goal index of a `.hbr2` |
| `src/officialRenderer.js` | Wraps node-haxball's renderer |
| `src/domShim.js` | Minimal DOM for the renderer |
| `src/audio.js` | Builds the audio track |
| `src/crowd.js` | Crowd volume model |
| `src/framesToVideo.js` | ffmpeg encoding |
| `src/assets.js` | Loads `res.dat` |

## Notes

- A replay with 7 goals takes about a minute at 960x540 and 60 fps on a laptop with a Ryzen 5.
- Avatar emoji and the goal text use system fonts. On Linux without an emoji font the emoji
  come out monochrome, and with Arial Black installed the text matches the game.
- node-haxball reads replays of version 3. If HaxBall changes the format, run
  `npm update node-haxball`.
- The crowd reacts to dangerous plays by reading player positions from node-haxball's state. If
  that structure changes in a future version, a warning is printed and only the goal crowd is
  used.

## Credits

Built on [node-haxball](https://github.com/wxyz-abcd/node-haxball) by wxyz-abcd, which provides
the replay reader and the renderer.

This project is not affiliated with HaxBall. HaxBall and its assets belong to their owner.

## License

ISC
