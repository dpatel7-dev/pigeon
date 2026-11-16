'use strict';
// pigeon's colours: clean and quick. "sky" is light, "dusk" is dark.

const A = require('./ansi');

const THEMES = {
  sky: {
    paper: { bg: '#f5f7fa', fg: '#1a2230' },
    dim: '#6b7587', faint: '#a7b0bf', line: '#dde2ea', select: '#e6edf7',
    teal: '#0f9a8b', violet: '#6d4fe0', orange: '#e2701f', ok: '#12935a', err: '#d0384a', link: '#2f63d6',
  },
  dusk: {
    paper: { bg: '#11151c', fg: '#e3e8f0' },
    dim: '#8a94a6', faint: '#4d5667', line: '#262d39', select: '#1b222d',
    teal: '#2bc4b2', violet: '#9b82ff', orange: '#ff9a4d', ok: '#3ccf8a', err: '#ff6b7a', link: '#7aa6ff',
  },
};
let current = THEMES.sky;
let name = 'sky';

function use(n) { name = THEMES[n] ? n : 'sky'; current = THEMES[name]; return current; }
const t = () => current;
const c = (key) => (s, extra = {}) => A.paint(s, { fg: current[key], ...extra });

module.exports = {
  THEMES, use, t, name: () => name,
  dim: c('dim'), faint: c('faint'), line: c('line'), teal: c('teal'), violet: c('violet'), orange: c('orange'), ok: c('ok'), err: c('err'), link: c('link'),
  bold: (s) => A.paint(s, { bold: true }),
};
