// Turn a polygon soup (cells, each assigned to a region or to water) into the
// shared mesh the level format stores: unique vertices, boundary edges as
// polylines between junctions (each edge stored once and reused by both
// sides), and one ring of signed edge references per region.
//
// Sides: region index ≥ 0, FRAME (-1) = outside the page, WATER (-2) = painted
// background water that is not part of the puzzle.

import { PRECISION, signedArea } from './geometry.mjs';

export const FRAME = -1;
export const WATER = -2;

export class MeshError extends Error {}

export function refEdge(ref) {
    return ref >= 0 ? ref : -ref - 1;
}

export function refForward(ref) {
    return ref >= 0;
}

/** Points of an edge reference in traversal order. */
export function refPoints(mesh, ref) {
    const e = mesh.edges[refEdge(ref)];
    const ids = refForward(ref) ? e.v : e.v.slice().reverse();
    return ids.map(id => mesh.vertices[id]);
}

export function ringPoints(mesh, ring) {
    const pts = [];
    for (const ref of ring) {
        const p = refPoints(mesh, ref);
        for (let i = 0; i < p.length - 1; i++) pts.push(p[i]);
    }
    return pts;
}

export function buildMesh(cells, { regionCount = null } = {}) {
    const vertices = [];
    const vmap = new Map();
    const vid = ([x, y]) => {
        const kx = Math.round(x * PRECISION);
        const ky = Math.round(y * PRECISION);
        const key = `${kx},${ky}`;
        let id = vmap.get(key);
        if (id === undefined) {
            id = vertices.length;
            vertices.push([kx / PRECISION, ky / PRECISION]);
            vmap.set(key, id);
        }
        return id;
    };

    // 1. snapped cell rings with consistent (positive) orientation
    const rings = [];
    cells.forEach((cell, ci) => {
        let ids = cell.ring.map(vid);
        ids = ids.filter((id, i) => id !== ids[(i + 1) % ids.length]);
        if (ids.length < 3) {
            if (cell.region >= 0) throw new MeshError(`cell ${ci} collapsed`);
            rings.push(null);
            return;
        }
        const area = signedArea(ids.map(i => vertices[i]));
        if (Math.abs(area) < 1) {
            if (cell.region >= 0) throw new MeshError(`cell ${ci} has no area`);
            rings.push(null);
            return;
        }
        if (area < 0) ids.reverse();
        rings.push(ids);
    });

    // 2. directed segments
    const owner = new Map();
    rings.forEach((ids, ci) => {
        if (!ids) return;
        for (let i = 0; i < ids.length; i++) {
            const a = ids[i];
            const b = ids[(i + 1) % ids.length];
            const key = `${a}>${b}`;
            if (owner.has(key)) throw new MeshError(`overlapping cells at segment ${key}`);
            owner.set(key, ci);
        }
    });

    // T-junction guard: every vertex lying on another segment must be one of its ends
    const regionOf = ci => cells[ci].region;
    const nRegions = regionCount ?? Math.max(-1, ...cells.map(c => c.region)) + 1;

    // 3. region boundary segments
    const boundary = []; // { a, b, left, right } left traverses a->b
    for (const [key, ci] of owner) {
        const [a, b] = key.split('>').map(Number);
        const left = regionOf(ci);
        const twin = owner.get(`${b}>${a}`);
        const right = twin === undefined ? FRAME : regionOf(twin);
        if (left === right) continue;
        if (left < 0) {
            // only emit from the land side (or from water vs frame, which is not needed)
            if (right >= 0) continue;
            continue;
        }
        boundary.push({ a, b, left, right });
    }

    // 4. undirected boundary segments + incidence
    const segs = [];
    const segKey = new Map();
    for (const s of boundary) {
        const k = s.a < s.b ? `${s.a}-${s.b}` : `${s.b}-${s.a}`;
        if (segKey.has(k)) continue; // twin already recorded from the other land side
        segKey.set(k, segs.length);
        const pair = s.left < s.right ? `${s.left}|${s.right}` : `${s.right}|${s.left}`;
        segs.push({ a: s.a, b: s.b, left: s.left, right: s.right, pair });
    }
    const incident = new Map();
    segs.forEach((s, i) => {
        for (const v of [s.a, s.b]) {
            if (!incident.has(v)) incident.set(v, []);
            incident.get(v).push(i);
        }
    });
    const isJunction = v => {
        const list = incident.get(v) || [];
        return list.length !== 2 || segs[list[0]].pair !== segs[list[1]].pair;
    };

    // 5. chain segments into edges
    const used = new Uint8Array(segs.length);
    const edges = [];
    const other = (si, v) => (segs[si].a === v ? segs[si].b : segs[si].a);
    for (let si = 0; si < segs.length; si++) {
        if (used[si]) continue;
        used[si] = 1;
        const chain = [segs[si].a, segs[si].b];
        let closed = false;
        // forward
        for (;;) {
            const end = chain[chain.length - 1];
            if (isJunction(end)) break;
            const next = incident.get(end).find(x => !used[x]);
            if (next === undefined) { closed = end === chain[0]; break; }
            used[next] = 1;
            chain.push(other(next, end));
        }
        if (!closed && chain[chain.length - 1] !== chain[0]) {
            for (;;) {
                const start = chain[0];
                if (isJunction(start)) break;
                const next = incident.get(start).find(x => !used[x]);
                if (next === undefined) break;
                used[next] = 1;
                chain.unshift(other(next, start));
            }
        }
        let poly = chain;
        if (poly[0] === poly[poly.length - 1] && !isJunction(poly[0])) {
            // closed loop without junction: rotate so it starts at its smallest vertex id
            const body = poly.slice(0, -1);
            let m = 0;
            for (let i = 1; i < body.length; i++) if (body[i] < body[m]) m = i;
            poly = body.slice(m).concat(body.slice(0, m), [body[m]]);
        }
        // orientation: forward traverser must be a land region
        const fKey = `${poly[0]}>${poly[1]}`;
        const fCell = owner.get(fKey);
        let fwd = fCell === undefined ? FRAME : regionOf(fCell);
        const bCell = owner.get(`${poly[1]}>${poly[0]}`);
        let bwd = bCell === undefined ? FRAME : regionOf(bCell);
        if (fwd < 0 || (bwd >= 0 && bwd < fwd)) {
            poly = poly.slice().reverse();
            [fwd, bwd] = [bwd, fwd];
        }
        edges.push({ v: poly, a: fwd, b: bwd });
    }

    // 6. region rings from signed edge refs
    const refsByRegion = Array.from({ length: nRegions }, () => []);
    edges.forEach((e, ei) => {
        refsByRegion[e.a].push(ei);
        if (e.b >= 0) refsByRegion[e.b].push(-ei - 1);
    });
    const regionRings = refsByRegion.map((refs, r) => {
        if (!refs.length) throw new MeshError(`region ${r} has no boundary`);
        const startOf = ref => (ref >= 0 ? edges[ref].v[0] : edges[-ref - 1].v[edges[-ref - 1].v.length - 1]);
        const endOf = ref => (ref >= 0 ? edges[ref].v[edges[ref].v.length - 1] : edges[-ref - 1].v[0]);
        const byStart = new Map();
        for (const ref of refs) {
            const s = startOf(ref);
            if (byStart.has(s)) throw new MeshError(`region ${r} pinches at vertex ${s}`);
            byStart.set(s, ref);
        }
        const ring = [refs[0]];
        let cur = endOf(refs[0]);
        while (cur !== startOf(refs[0])) {
            const ref = byStart.get(cur);
            if (ref === undefined) throw new MeshError(`region ${r} boundary is open`);
            ring.push(ref);
            cur = endOf(ref);
            if (ring.length > refs.length) throw new MeshError(`region ${r} boundary loops`);
        }
        if (ring.length !== refs.length) throw new MeshError(`region ${r} has a hole or several parts`);
        return ring;
    });

    // 7. compact vertex table to the vertices edges actually use
    const keep = new Map();
    const outVertices = [];
    for (const e of edges) {
        e.v = e.v.map(id => {
            if (!keep.has(id)) {
                keep.set(id, outVertices.length);
                outVertices.push(vertices[id]);
            }
            return keep.get(id);
        });
    }
    return { vertices: outVertices, edges, rings: regionRings };
}
