'use strict';
// Coo, pigeon's pigeon. Bobs while waiting, flies with a letter while sending,
// flies home while fetching, and fluffs up when something goes wrong.

const S = require('./sprite');

const BASE = [
  '....................',
  '...........GGG......',
  '..........GGGGG.....',
  '..........GEKGGB....',
  '..........GGGGGBB...',
  '.........NnNGG......',
  '........NnNnN.......',
  '...GGGGGNnNnG.......',
  '..GGWWWWGGGGGG......',
  '.TGWWWWWWGGGGG......',
  'TTGGWWWWWWGGGG......',
  'TTTGGGGGGGGGG.......',
  '...TTGGGGGGG........',
  '.......F..F.........',
  '......FF.FF.........',
  '....................',
];

const INK = {
  G: '#8f9aab', g: '#6b7586', W: '#c8d0dc', N: '#22b3a2', n: '#8a5cf6', E: '#ff8a3d', K: '#151a22',
  B: '#4a505c', F: '#ff8a3d', T: '#56606f', L: '#ffffff', l: '#d6dbe4', R: '#ff5d73', H: '#a9b3c2',
};

const HEAD = 7; // rows above this are the head and neck
const bob = (g, dx) => S.shift(g, dx, HEAD);
const blink = (g) => g.map((r) => r.replace('EK', 'GG'));
const peck = S.edit(BASE, {
  1: '....................', 2: '....................', 3: '...........GGG......', 4: '..........GGGGG.....',
  5: '.........NGEKGGB....', 6: '........NnNGGGGBB...',
});

// wings up / wings down, for flying
const WING_UP = S.edit(BASE, {
  4: '....HH....GGGGGBB...', 5: '...HHHH..NnNGG......', 6: '..HHHHHHNnNnN.......',
  13: '....................', 14: '....................',
});
const WING_DOWN = S.edit(BASE, {
  12: '...TTGGGGGGG........', 13: '....HHHHHH..........', 14: '.....HHHH...........',
});
const letter = (g, x, y) => S.dots(g, [[x, y, 'L'], [x + 1, y, 'L'], [x + 2, y, 'L'], [x, y + 1, 'l'], [x + 1, y + 1, 'R'], [x + 2, y + 1, 'l']]);
const fluff = (g) => S.dots(g, [[1, 7, 'H'], [14, 8, 'H'], [0, 9, 'H'], [15, 10, 'H'], [2, 12, 'H']]);
const lift = (g, dy) => (dy > 0 ? g.slice(dy).concat(Array(dy).fill('.'.repeat(20))) : g);

const f = (grid, ms = 220) => ({ grid, ms });

const SCENES = {
  idle: [f(BASE, 1100), f(bob(BASE, 1), 350), f(BASE, 900), f(peck, 250), f(BASE, 500), f(blink(BASE), 150), f(BASE, 900)],
  send: [f(letter(lift(WING_UP, 1), 16, 4)), f(letter(WING_DOWN, 16, 5)), f(letter(lift(WING_UP, 2), 16, 3)), f(letter(lift(WING_DOWN, 1), 16, 4))],
  get: [f(S.flip(letter(lift(WING_UP, 1), 16, 4))), f(S.flip(letter(WING_DOWN, 16, 5))), f(S.flip(letter(lift(WING_UP, 2), 16, 3))), f(S.flip(letter(lift(WING_DOWN, 1), 16, 4)))],
  done: [f(bob(BASE, 1), 300), f(BASE, 300), f(bob(BASE, 1), 300), f(BASE, 300), f(blink(BASE), 160), f(BASE, 900)],
  oops: [f(fluff(BASE), 500), f(fluff(bob(BASE, -1)), 400), f(fluff(BASE), 700)],
  wait: [f(BASE, 700), f(peck, 300), f(BASE, 500), f(peck, 300), f(bob(BASE, 1), 500), f(BASE, 600)],
};

const WIDTH = 20;
const HEIGHT = 8;

function frameAt(scene, ms) {
  const frames = SCENES[scene] || SCENES.idle;
  const total = frames.reduce((n, x) => n + x.ms, 0);
  let at = ms % total;
  for (const fr of frames) {
    if (at < fr.ms) return fr.grid;
    at -= fr.ms;
  }
  return frames[0].grid;
}

const length = (scene) => (SCENES[scene] || SCENES.idle).reduce((n, x) => n + x.ms, 0);
const draw = (scene, ms, bg) => S.draw(frameAt(scene, ms), INK, { bg });

module.exports = { draw, length, SCENES, WIDTH, HEIGHT, BASE, INK };
