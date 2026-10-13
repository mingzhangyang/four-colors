// Artwork export: a restored page (or the complete work) rendered to a canvas
// and saved as PNG, plus spoiler-free share text. Shared text never reveals the
// solution coloring: its pattern is derived from the page id only.

import { artworkFor, borderPaths } from '../render/scenery.js';
import { EMPTY } from '../model/rules.js';
import { fnv1a } from '../content/checksum.js';

const PAPER = '#faf6ec';
const INK = '#2b3337';
const SEA = '#b9d1d2';
const EMPTY_FILL = '#fbf7ef';

// The high-contrast skin keeps stronger texture ink and borders, as on screen.
const LINE = {
    normal: { tex: 'rgba(30,30,30,0.17)', inner: 1.2, outer: 2.2 },
    contrast: { tex: 'rgba(8,12,14,0.4)', inner: 1.7, outer: 2.6 },
};

function texturePattern(ctx, c, ink) {
    const size = 24;
    const cv = document.createElement('canvas');
    cv.width = size;
    cv.height = size;
    const g = cv.getContext('2d');
    g.strokeStyle = ink;
    g.fillStyle = ink;
    g.lineWidth = 1.6;
    if (c === 0) { g.beginPath(); g.arc(12, 12, 3, 0, Math.PI * 2); g.fill(); }
    if (c === 1) { g.beginPath(); g.moveTo(-4, 4); g.lineTo(4, -4); g.moveTo(0, 24); g.lineTo(24, 0); g.moveTo(20, 28); g.lineTo(28, 20); g.stroke(); }
    if (c === 2) { g.beginPath(); g.moveTo(0, 1); g.lineTo(24, 1); g.moveTo(1, 0); g.lineTo(1, 24); g.stroke(); }
    if (c === 3) { g.beginPath(); g.arc(12, 12, 6.5, 0, Math.PI * 2); g.stroke(); }
    return ctx.createPattern(cv, 'repeat');
}

/** Draw one page into ctx at the current transform (map coordinates). */
export function drawPage(ctx, level, colors, { palette, texture = true, art = true, contrast = false }) {
    const [x, y, w, h] = level.box;
    const line = contrast ? LINE.contrast : LINE.normal;
    if (level.water) {
        ctx.fillStyle = SEA;
        ctx.fillRect(x, y, w, h);
    }
    const patterns = texture ? [0, 1, 2, 3].map(c => texturePattern(ctx, c, line.tex)) : null;
    level.paths.forEach((d, i) => {
        const p = new Path2D(d);
        const c = colors[i];
        ctx.fillStyle = c === EMPTY ? EMPTY_FILL : palette[c];
        ctx.fill(p);
        if (patterns && c !== EMPTY) {
            ctx.save();
            ctx.fillStyle = patterns[c];
            ctx.globalAlpha = 0.9;
            ctx.scale(0.5, 0.5);
            ctx.fill(new Path2D(scalePath(d, 2)));
            ctx.restore();
        }
    });
    ctx.strokeStyle = INK;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const borders = borderPaths(level);
    ctx.lineWidth = line.inner;
    ctx.stroke(new Path2D(borders.inner));
    ctx.lineWidth = line.outer;
    ctx.stroke(new Path2D(borders.outer));
    if (art) {
        for (const { x: ax, y: ay, scale, paths } of artworkFor(level)) {
            ctx.save();
            ctx.translate(ax, ay);
            ctx.scale(scale, scale);
            for (const { d, fill } of paths) {
                if (fill) {
                    ctx.fillStyle = 'rgba(255,250,231,0.65)';
                    ctx.fill(new Path2D(d));
                } else {
                    ctx.lineWidth = 1.8;
                    ctx.strokeStyle = 'rgba(255,253,247,0.55)';
                    ctx.stroke(new Path2D(d));
                    ctx.lineWidth = 0.85;
                    ctx.strokeStyle = INK;
                    ctx.stroke(new Path2D(d));
                }
            }
            ctx.restore();
        }
    }
}

function scalePath(d, k) {
    return d.replace(/-?\d+(\.\d+)?/g, m => String(Number(m) * k));
}

function drawSeal(ctx, cx, cy, r, text) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-0.12);
    ctx.strokeStyle = '#a63d2a';
    ctx.fillStyle = 'rgba(166,61,42,0.08)';
    ctx.lineWidth = r * 0.09;
    ctx.beginPath();
    ctx.roundRect(-r, -r * 0.62, r * 2, r * 1.24, r * 0.18);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#a63d2a';
    ctx.font = `600 ${r * 0.5}px "Songti SC", "Noto Serif SC", serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 0, 2);
    ctx.restore();
}

export function renderPage(level, colors, { palette, texture = true, contrast = false, title = '', subtitle = '', seal = '' }) {
    const [x, y, w, h] = level.box;
    const scale = 2;
    const margin = 36;
    const header = 70;
    const cv = document.createElement('canvas');
    cv.width = Math.round((w + margin * 2) * scale);
    cv.height = Math.round((h + margin * 2 + header) * scale);
    const ctx = cv.getContext('2d');
    ctx.scale(scale, scale);
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, w + margin * 2, h + margin * 2 + header);
    ctx.fillStyle = INK;
    ctx.font = '600 24px "Songti SC", "Noto Serif SC", Georgia, serif';
    ctx.fillText(title, margin, margin + 18);
    ctx.font = '14px system-ui, sans-serif';
    ctx.fillStyle = '#5b6266';
    ctx.fillText(subtitle, margin, margin + 42);
    ctx.save();
    ctx.translate(margin - x, margin + header - y);
    drawPage(ctx, level, colors, { palette, texture, contrast });
    ctx.restore();
    if (seal) drawSeal(ctx, w + margin - 34, margin + 22, 30, seal);
    return cv;
}

/** The complete work: every main page in one sheet (8 columns × 4 chapters). */
export function renderMosaic(levels, colorsFor, paletteFor, { title = '', texture = false, contrast = false }) {
    const cellW = 120;
    const cellH = 160;
    const gap = 10;
    const margin = 30;
    const header = 50;
    const cols = 8;
    const rows = Math.ceil(levels.length / cols);
    const scale = 2;
    const W = margin * 2 + cols * cellW + (cols - 1) * gap;
    const H = margin * 2 + header + rows * cellH + (rows - 1) * gap;
    const cv = document.createElement('canvas');
    cv.width = W * scale;
    cv.height = H * scale;
    const ctx = cv.getContext('2d');
    ctx.scale(scale, scale);
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = INK;
    ctx.font = '600 24px "Songti SC", "Noto Serif SC", Georgia, serif';
    ctx.fillText(title, margin, margin + 20);
    levels.forEach((lv, k) => {
        const col = k % cols;
        const row = Math.floor(k / cols);
        const [x, y, w, h] = lv.box;
        const s = Math.min(cellW / w, cellH / h);
        ctx.save();
        ctx.translate(margin + col * (cellW + gap) + (cellW - w * s) / 2, margin + header + row * (cellH + gap) + (cellH - h * s) / 2);
        ctx.scale(s, s);
        ctx.translate(-x, -y);
        const colors = colorsFor(lv);
        drawPage(ctx, lv, colors || lv.paths.map(() => EMPTY), { palette: paletteFor(lv), texture, contrast, art: Boolean(colors) });
        ctx.restore();
    });
    return cv;
}

export function downloadCanvas(canvas, filename) {
    return new Promise(resolve => {
        canvas.toBlob(blob => {
            if (!blob) { resolve(false); return; }
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.append(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 2000);
            resolve(true);
        }, 'image/png');
    });
}

const GLYPHS = ['◐', '◑', '◒', '◓', '▚', '▞', '◆', '◇'];

/** A stamp-like pattern derived from the page id only — never from colors. */
export function stampPattern(id) {
    const h = parseInt(fnv1a(`stamp:${id}`), 16);
    let out = '';
    for (let i = 0; i < 6; i++) out += GLYPHS[(h >>> (i * 3)) & 7];
    return out;
}
