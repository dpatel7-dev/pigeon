'use strict';
// The text you're typing: a small multi-line editor with the usual shortcuts.

const { graphemes, gWidth } = require('./ansi');

class Editor {
  constructor() {
    this.text = '';
    this.cursor = 0; // index into this.text (UTF-16 units), always on a grapheme boundary
  }

  set(text) {
    this.text = text;
    this.cursor = text.length;
  }

  clear() {
    this.set('');
  }

  insert(s) {
    if (!s) return;
    this.text = this.text.slice(0, this.cursor) + s + this.text.slice(this.cursor);
    this.cursor += s.length;
  }

  _bounds() {
    const b = [0];
    let i = 0;
    for (const g of graphemes(this.text)) { i += g.length; b.push(i); }
    return b;
  }

  _prev(i) {
    let p = 0;
    for (const x of this._bounds()) { if (x >= i) break; p = x; }
    return p;
  }

  _next(i) {
    for (const x of this._bounds()) if (x > i) return x;
    return this.text.length;
  }

  left() { this.cursor = this._prev(this.cursor); }
  right() { this.cursor = this._next(this.cursor); }

  home() {
    this.cursor = this.text.lastIndexOf('\n', this.cursor - 1) + 1;
  }

  end() {
    const n = this.text.indexOf('\n', this.cursor);
    this.cursor = n < 0 ? this.text.length : n;
  }

  _wordLeftPos() {
    let i = this.cursor;
    while (i > 0 && /\s/.test(this.text[i - 1])) i--;
    while (i > 0 && !/\s/.test(this.text[i - 1])) i--;
    return i;
  }

  _wordRightPos() {
    let i = this.cursor;
    const n = this.text.length;
    while (i < n && /\s/.test(this.text[i])) i++;
    while (i < n && !/\s/.test(this.text[i])) i++;
    return i;
  }

  wordLeft() { this.cursor = this._wordLeftPos(); }
  wordRight() { this.cursor = this._wordRightPos(); }

  backspace() {
    if (this.cursor === 0) return;
    const p = this._prev(this.cursor);
    this.text = this.text.slice(0, p) + this.text.slice(this.cursor);
    this.cursor = p;
  }

  del() {
    if (this.cursor >= this.text.length) return;
    this.text = this.text.slice(0, this.cursor) + this.text.slice(this._next(this.cursor));
  }

  deleteWord() {
    const p = this._wordLeftPos();
    this.text = this.text.slice(0, p) + this.text.slice(this.cursor);
    this.cursor = p;
  }

  killToStart() {
    const start = this.text.lastIndexOf('\n', this.cursor - 1) + 1;
    this.text = this.text.slice(0, start) + this.text.slice(this.cursor);
    this.cursor = start;
  }

  killToEnd() {
    const n = this.text.indexOf('\n', this.cursor);
    const end = n < 0 ? this.text.length : n;
    this.text = this.text.slice(0, this.cursor) + this.text.slice(end);
  }

  /**
   * Lay the text out in a box `width` columns wide, showing at most `maxLines`.
   * Returns the visible lines and where the cursor sits within them.
   */
  layout(width, maxLines = 6) {
    width = Math.max(4, width);
    const lines = [''];
    let col = 0;
    let idx = 0;
    let cur = null;
    for (const g of graphemes(this.text)) {
      if (idx === this.cursor) cur = { row: lines.length - 1, col };
      idx += g.length;
      if (g === '\n') { lines.push(''); col = 0; continue; }
      const w = gWidth(g);
      if (col + w > width) { lines.push(''); col = 0; }
      lines[lines.length - 1] += g;
      col += w;
    }
    if (cur === null) {
      if (col >= width) { lines.push(''); col = 0; }
      cur = { row: lines.length - 1, col };
    }
    const total = lines.length;
    let top = 0;
    if (total > maxLines) top = Math.max(0, Math.min(cur.row - maxLines + 1, total - maxLines));
    if (cur.row < top) top = cur.row;
    return { lines: lines.slice(top, top + maxLines), row: cur.row - top, col: cur.col, total, top };
  }
}

module.exports = { Editor };
