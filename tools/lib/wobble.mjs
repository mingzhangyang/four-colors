// Hand-drawn boundary character. Each shared edge is resampled and displaced
// once, so both neighbouring regions keep using the identical polyline:
// art never changes adjacency. Junction vertices stay put.

import { round } from './geometry.mjs';
import { FRAME, WATER } from './mesh-build.mjs';

function resample(points, step) {
    const out = [points[0]];
    for (let i = 0; i < points.length - 1; i++) {
        const [x1, y1] = points[i];
        const [x2, y2] = points[i + 1];
        const len = Math.hypot(x2 - x1, y2 - y1);
        const parts = Math.max(1, Math.ceil(len / step));
        for (let k = 1; k <= parts; k++) out.push([x1 + ((x2 - x1) * k) / parts, y1 + ((y2 - y1) * k) / parts]);
    }
    return out;
}

function polyLength(points) {
    let L = 0;
    for (let i = 0; i < points.length - 1; i++) L += Math.hypot(points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1]);
    return L;
}

/**
 * opts.amp: interior edge amplitude, opts.coastAmp: edges against water,
 * opts.frameAmp: edges on the page frame (usually 0), opts.step: resample spacing,
 * opts.scale: per-edge multiplier map (edge index -> factor) used for retries.
 */
export function wobbleMesh(mesh, rng, opts = {}) {
    const { amp = 3, coastAmp = 5, frameAmp = 0, step = 9, scale = null } = opts;
    const vertices = mesh.vertices.map(p => p.slice());
    const edges = mesh.edges.map((e, ei) => {
        const pts = e.v.map(id => vertices[id]);
        const kind = e.b === FRAME ? 'frame' : e.b === WATER ? 'coast' : 'inner';
        const base = kind === 'frame' ? frameAmp : kind === 'coast' ? coastAmp : amp;
        const factor = scale && scale.has(ei) ? scale.get(ei) : 1;
        const phase1 = rng() * Math.PI * 2;
        const phase2 = rng() * Math.PI * 2;
        const f1 = 1 + Math.floor(rng() * 2);
        const f2 = 2 + Math.floor(rng() * 3);
        if (base * factor <= 0) return { ...e, v: e.v.slice() };
        const dense = resample(pts, step);
        const L = polyLength(dense);
        const A = Math.min(base, 0.075 * L) * factor;
        const out = [e.v[0]];
        let acc = 0;
        for (let i = 1; i < dense.length - 1; i++) {
            acc += Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]);
            const t = acc / L;
            const [px, py] = dense[i - 1];
            const [qx, qy] = dense[i + 1];
            const len = Math.hypot(qx - px, qy - py) || 1;
            const nx = -(qy - py) / len;
            const ny = (qx - px) / len;
            const taper = Math.pow(Math.sin(Math.PI * t), 0.8);
            const off = A * taper * (0.65 * Math.sin(2 * Math.PI * f1 * t + phase1) + 0.35 * Math.sin(2 * Math.PI * f2 * t + phase2));
            const p = [round(dense[i][0] + nx * off), round(dense[i][1] + ny * off)];
            const prev = vertices[out[out.length - 1]];
            if (prev[0] === p[0] && prev[1] === p[1]) continue;
            vertices.push(p);
            out.push(vertices.length - 1);
        }
        out.push(e.v[e.v.length - 1]);
        return { ...e, v: out };
    });
    return compact({ vertices, edges, rings: mesh.rings.map(r => r.slice()) });
}

/** Drop unused vertices and merge vertices that landed on the same coordinate. */
export function compact(mesh) {
    const keep = new Map();
    const byCoord = new Map();
    const vertices = [];
    const edges = mesh.edges.map(e => {
        const v = [];
        for (const id of e.v) {
            let nid = keep.get(id);
            if (nid === undefined) {
                const [x, y] = mesh.vertices[id];
                const key = `${Math.round(x * 10)},${Math.round(y * 10)}`;
                nid = byCoord.get(key);
                if (nid === undefined) {
                    nid = vertices.length;
                    vertices.push([x, y]);
                    byCoord.set(key, nid);
                }
                keep.set(id, nid);
            }
            if (v[v.length - 1] !== nid) v.push(nid);
        }
        return { ...e, v };
    });
    return { vertices, edges, rings: mesh.rings };
}

/** Apply a point transform to every vertex (used for warped "same structure" views). */
export function transformMesh(mesh, fn, step = 6) {
    // densify first so smooth warps stay smooth
    const vertices = mesh.vertices.map(p => p.slice());
    const edges = mesh.edges.map(e => {
        const pts = e.v.map(id => vertices[id]);
        const out = [e.v[0]];
        for (let i = 0; i < pts.length - 1; i++) {
            const [x1, y1] = pts[i];
            const [x2, y2] = pts[i + 1];
            const parts = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / step));
            for (let k = 1; k < parts; k++) {
                vertices.push([x1 + ((x2 - x1) * k) / parts, y1 + ((y2 - y1) * k) / parts]);
                out.push(vertices.length - 1);
            }
            out.push(e.v[i + 1]);
        }
        return { ...e, v: out };
    });
    const moved = vertices.map(p => {
        const [x, y] = fn(p);
        return [round(x), round(y)];
    });
    const out = compact({ vertices: moved, edges, rings: mesh.rings.map(r => r.slice()) });
    return fixOrientation(out);
}

/**
 * A mirroring transform flips every ring to negative area. Reversing each
 * edge's vertex order together with each ring's reference order restores
 * positive rings while every edge keeps the same forward region.
 */
export function fixOrientation(mesh) {
    const pts = [];
    for (const ref of mesh.rings[0]) {
        const e = mesh.edges[ref >= 0 ? ref : -ref - 1];
        const ids = ref >= 0 ? e.v : e.v.slice().reverse();
        for (let i = 0; i < ids.length - 1; i++) pts.push(mesh.vertices[ids[i]]);
    }
    let s = 0;
    for (let i = 0; i < pts.length; i++) {
        const [x1, y1] = pts[i];
        const [x2, y2] = pts[(i + 1) % pts.length];
        s += x1 * y2 - x2 * y1;
    }
    if (s >= 0) return mesh;
    return {
        vertices: mesh.vertices,
        edges: mesh.edges.map(e => ({ ...e, v: e.v.slice().reverse() })),
        rings: mesh.rings.map(r => r.slice().reverse()),
    };
}
