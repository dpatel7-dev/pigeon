'use strict';
// Pixel art in the terminal.
//
// Every letter in a drawing is one pixel and '.' is see-through. Two rows of
// pixels share one line of text, so a 16x16 drawing takes 16 columns by 8 lines.
// Solid cells are drawn as coloured spaces (never block characters), which is
// what keeps them free of thin seams in terminals like macOS Terminal.

const A = require('./ansi');

const px = (grid, x, y) => {
  const row = grid[y];
  const c = row ? row[x] : undefined;
  return c && c !== '.' && c !== ' ' ? c : null;
};

/**
 * Draw a grid. `ink` maps letters to colours ('#rrggbb'). `bg` is the colour
 * behind the picture (the screen's background) - knowing it lets half-filled
 * cells be painted completely. Returns one string per line of text.
 */
function draw(grid, ink, { bg = null } = {}) {
  const h = grid.length;
  const w = Math.max(0, ...grid.map((r) => r.length));
  const lines = [];
  for (let y = 0; y < h; y += 2) {
    let line = '';
    for (let x = 0; x < w; x++) {
      const t = px(grid, x, y);
      const b = px(grid, x, y + 1);
      line += cell(t ? ink[t] : null, b ? ink[b] : null, bg);
    }
    lines.push(line);
  }
  return lines;
}

function cell(top, bottom, bg) {
  if (A.getLevel() === 0) return top || bottom ? (top && bottom ? '█' : top ? '▀' : '▄') : ' ';
  if (!top && !bottom) return bg ? A.paint(' ', { bg }) : ' ';
  // Block characters don't quite fill their half of the line in terminals that
  // add line spacing (macOS Terminal leaves a sliver at the TOP of each line),
  // but a background colour always fills the whole cell. So anything touching
  // the top of a cell is drawn as background, with the lower-half block ▄ (which
  // does sit flush with the bottom) on top of it. Never ▀.
  if (top && bottom) return top === bottom ? A.paint(' ', { bg: top }) : A.paint('▄', { fg: bottom, bg: top });
  if (top) return bg ? A.paint('▄', { fg: bg, bg: top }) : A.paint('▀', { fg: top });
  return A.paint('▄', bg ? { fg: bottom, bg } : { fg: bottom });
}

// ── small helpers for building animation frames ───────────────────────────────

/** Change some rows: edit(grid, { 3: '..XX..' }). */
const edit = (grid, rows) => grid.map((r, i) => (rows[i] !== undefined ? rows[i] : r));
/** Move everything above row `from` sideways by dx pixels (a lean or sway). */
const shift = (grid, dx, from = grid.length) => grid.map((r, i) => {
  if (i >= from || !dx) return r;
  return dx > 0 ? '.'.repeat(dx) + r.slice(0, r.length - dx) : r.slice(-dx) + '.'.repeat(-dx);
});
/** Swap one letter for another everywhere. */
const recolor = (grid, from, to) => grid.map((r) => r.split(from).join(to));
/** Mirror left to right. */
const flip = (grid) => grid.map((r) => r.split('').reverse().join(''));
/** Put single pixels on top: dots(grid, [[x, y, 'P'], ...]). */
const dots = (grid, list) => {
  const g = grid.map((r) => r.split(''));
  for (const [x, y, c] of list) if (g[y] && x >= 0 && x < g[y].length) g[y][x] = c;
  return g.map((r) => r.join(''));
};

module.exports = { draw, cell, edit, shift, recolor, flip, dots };
