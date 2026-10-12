// Hand-built pages for the specification levels (FC03, FC08, FC16, FC26) and
// helpers that derive "same structure, different look" views (FC23, FC24).
// They are authored as region polygons with exactly shared vertices; the
// regular mesh builder turns them into shared edges, so adjacency still comes
// only from geometry.

import { rectRing } from '../lib/mapgen.mjs';
import { round } from '../lib/geometry.mjs';

const r1 = v => round(v);
const pt = (x, y) => [r1(x), r1(y)];

export const PAGE = [20, 20, 460, 620];

/** FC03: a 2×2 grid. Diagonal regions meet at one corner only. */
export function grid2x2(frame = PAGE) {
    const [x0, y0, x1, y1] = frame;
    const cx = r1((x0 + x1) / 2);
    const cy = r1((y0 + y1) / 2);
    const cells = [
        [[x0, y0], [cx, y0], [cx, cy], [x0, cy]],
        [[cx, y0], [x1, y0], [x1, cy], [cx, cy]],
        [[cx, cy], [x1, cy], [x1, y1], [cx, y1]],
        [[x0, cy], [cx, cy], [cx, y1], [x0, y1]],
    ];
    // ids follow reading order around the square: A top-left, B top-right, C bottom-right, D bottom-left
    return { cells: cells.map((ring, i) => ({ ring, region: i })), regionIds: ['A', 'B', 'C', 'D'] };
}

/** FC08: three outer sectors that touch pairwise plus a centre touching all three (K4). */
export function k4Disc({ cx = 240, cy = 320, R = 212, r = 82, steps = 60 } = {}) {
    const at = (rad, deg) => pt(cx + rad * Math.cos((deg * Math.PI) / 180), cy + rad * Math.sin((deg * Math.PI) / 180));
    const step = 360 / steps;
    const arc = (rad, from, to) => {
        const out = [];
        for (let d = from; d <= to + 1e-9; d += step) out.push(at(rad, d));
        return out;
    };
    const sector = (from, to) => [...arc(R, from, to), ...arc(r, from, to).reverse()];
    const centre = arc(r, 0, 360 - step);
    return {
        cells: [
            { ring: sector(-90, 30), region: 0 },   // A: upper right
            { ring: sector(30, 150), region: 1 },   // B: bottom
            { ring: sector(150, 270), region: 2 },  // C: upper left
            { ring: centre, region: 3 },            // D: centre
        ],
        regionIds: ['A', 'B', 'C', 'D'],
    };
}

/**
 * FC16: centre X inside a ring R1–R6 of six trapezoids, with four corner
 * plots filling the rest of the page. Corner cuts start from edge midpoints
 * so that every junction joins exactly three regions (no corner contacts).
 */
export function hexRing({ frame = PAGE, cx = 240, cy = 320, rIn = 74, rOut = 162 } = {}) {
    const [x0, y0, x1, y1] = frame;
    const hex = (rad, deg) => pt(cx + rad * Math.cos((deg * Math.PI) / 180), cy + rad * Math.sin((deg * Math.PI) / 180));
    const mid = (p, q) => pt((p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
    const O = [0, 60, 120, 180, 240, 300].map(d => hex(rOut, d));
    const I = [0, 60, 120, 180, 240, 300].map(d => hex(rIn, d));
    // indices: 0 right, 1 bottom-right, 2 bottom-left, 3 left, 4 top-left, 5 top-right
    const mTop = mid(O[4], O[5]);
    const mBot = mid(O[1], O[2]);
    const mTL = mid(O[3], O[4]); // midpoint of R6 outer edge (left-upper side)
    const mBR = mid(O[0], O[1]); // midpoint of R3 outer edge (right-lower side)
    const X = [I[0], I[1], I[2], I[3], I[4], I[5]];
    const R1 = [O[4], mTop, O[5], I[5], I[4]];          // top
    const R2 = [O[5], O[0], I[0], I[5]];                // top-right
    const R3 = [O[0], mBR, O[1], I[1], I[0]];           // bottom-right
    const R4 = [O[1], mBot, O[2], I[2], I[1]];          // bottom
    const R5 = [O[2], O[3], I[3], I[2]];                // bottom-left
    const R6 = [O[3], mTL, O[4], I[4], I[3]];           // top-left
    const topCut = pt(mTop[0], y0);
    const botCut = pt(mBot[0], y1);
    const leftCut = pt(x0, mTL[1]);
    const rightCut = pt(x1, mBR[1]);
    const TL = [[x0, y0], topCut, mTop, O[4], mTL, leftCut];
    const TR = [topCut, [x1, y0], rightCut, mBR, O[0], O[5], mTop];
    const BR = [rightCut, [x1, y1], botCut, mBot, O[1], mBR];
    const BL = [botCut, [x0, y1], leftCut, mTL, O[3], O[2], mBot];
    const rings = [X, R1, R2, R3, R4, R5, R6, TL, TR, BR, BL];
    return {
        cells: rings.map((ring, i) => ({ ring, region: i })),
        regionIds: ['X', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'NW', 'NE', 'SE', 'SW'],
    };
}

/** FC26: four bands, A—B—C—D, each touching only its neighbours. */
export function bands(count = 4, frame = PAGE) {
    const [x0, y0, x1, y1] = frame;
    const ys = [];
    for (let i = 0; i <= count; i++) ys.push(r1(y0 + ((y1 - y0) * i) / count));
    const cells = [];
    for (let i = 0; i < count; i++) cells.push({ ring: rectRing([x0, ys[i], x1, ys[i + 1]]), region: i });
    return { cells, regionIds: ['A', 'B', 'C', 'D', 'E', 'F'].slice(0, count) };
}

/** Smooth, orientation-preserving warp used to redraw a page with the same structure. */
export function warpFn({ frame = PAGE, ax = 26, ay = 22, fx = 1.3, fy = 1.1, phase = 0.7, mirror = false, rotate = false }) {
    const [x0, y0, x1, y1] = frame;
    const W = x1 - x0;
    const H = y1 - y0;
    return ([x, y]) => {
        let u = (x - x0) / W;
        let v = (y - y0) / H;
        if (mirror) u = 1 - u;
        if (rotate) { u = 1 - u; v = 1 - v; }
        // displacement vanishes on the frame so the page outline stays a rectangle
        const du = (ax / W) * Math.sin(Math.PI * u) * Math.sin(2 * Math.PI * fy * v + phase);
        const dv = (ay / H) * Math.sin(Math.PI * v) * Math.sin(2 * Math.PI * fx * u + phase * 1.7);
        return [x0 + (u + du) * W, y0 + (v + dv) * H];
    };
}

/** Place mesh B next to mesh A in one level (regions of B are offset by A's count). */
export function combineMeshes(a, b) {
    const vOff = a.vertices.length;
    const eOff = a.edges.length;
    const rOff = a.rings.length;
    return {
        vertices: a.vertices.concat(b.vertices),
        edges: a.edges.concat(b.edges.map(e => ({ ...e, v: e.v.map(v => v + vOff), a: e.a + rOff, b: e.b >= 0 ? e.b + rOff : e.b }))),
        rings: a.rings.concat(b.rings.map(r => r.map(ref => (ref >= 0 ? ref + eOff : ref - eOff)))),
    };
}

/** Translate/scale a whole mesh. */
export function placeMesh(mesh, fn) {
    return { ...mesh, vertices: mesh.vertices.map(p => { const [x, y] = fn(p); return [round(x), round(y)]; }) };
}
