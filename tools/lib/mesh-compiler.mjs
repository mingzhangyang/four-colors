// Level geometry compiler. Input: a mesh of shared vertices, edges (polylines
// with a forward region `a` and a backward side `b`) and region rings (signed
// edge references). It validates the topology and derives everything the
// runtime needs — adjacency, region/edge SVG paths, label points, inscribed
// radii. The adjacency table is never authored by hand.
//
// Checks: fixed precision, zero-length edges, non-manifold edge use, open or
// non-simple rings, crossing/overlapping edges, nested regions, duplicated
// vertices (cracks), near-coincident boundaries, corner-only contacts, minimum
// shared boundary and minimum inscribed radius (touch floor).

import { PRECISION, signedArea, isSimpleRing, pointInRing, polylabel, segmentsTouch, segmentDistance, bbox } from './geometry.mjs';
import { refEdge, refForward } from './mesh-build.mjs';

const fmt = v => {
    const r = Math.round(v * PRECISION) / PRECISION;
    return Number.isInteger(r) ? String(r) : r.toFixed(1);
};

export function pathFromPoints(points, close = true) {
    let d = `M${fmt(points[0][0])},${fmt(points[0][1])}`;
    for (let i = 1; i < points.length; i++) d += ` ${fmt(points[i][0])},${fmt(points[i][1])}`;
    return close ? `${d}Z` : d;
}

function edgeLength(pts) {
    let L = 0;
    for (let i = 0; i < pts.length - 1; i++) L += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    return L;
}

export function compileMesh(mesh, opts = {}) {
    const {
        minInradius = 0,
        minShared = 0,
        allowCornerContacts = false,
        minGap = 0.6,
        regionIds = null,
    } = opts;
    const errors = [];
    const warn = [];
    const err = msg => errors.push(msg);
    const { vertices, edges, rings } = mesh;
    const n = rings.length;
    const name = r => (regionIds ? regionIds[r] : `#${r}`);

    // fixed precision + unique coordinates
    const coordSeen = new Map();
    vertices.forEach(([x, y], i) => {
        if (!Number.isFinite(x) || !Number.isFinite(y)) err(`vertex ${i} is not finite`);
        if (Math.abs(x * PRECISION - Math.round(x * PRECISION)) > 1e-6 || Math.abs(y * PRECISION - Math.round(y * PRECISION)) > 1e-6) {
            err(`vertex ${i} is off the fixed-precision grid`);
        }
        const key = `${Math.round(x * PRECISION)},${Math.round(y * PRECISION)}`;
        if (coordSeen.has(key)) err(`vertices ${coordSeen.get(key)} and ${i} coincide (crack)`);
        coordSeen.set(key, i);
    });

    // edges
    const edgePts = edges.map((e, ei) => {
        if (!Array.isArray(e.v) || e.v.length < 2) { err(`edge ${ei} has fewer than two points`); return []; }
        for (let i = 0; i < e.v.length - 1; i++) if (e.v[i] === e.v[i + 1]) err(`edge ${ei} repeats a point`);
        if (!(e.a >= 0 && e.a < n)) err(`edge ${ei} has invalid forward region`);
        if (!(e.b >= -2 && e.b < n) || e.a === e.b) err(`edge ${ei} has invalid backward side`);
        const pts = e.v.map(id => vertices[id]);
        if (edgeLength(pts) <= 0) err(`edge ${ei} has zero length`);
        return pts;
    });
    if (errors.length) return { errors, warnings: warn };

    // edge usage: exactly once forward by a, once backward by b (if b is a region)
    const fwdUse = new Array(edges.length).fill(0);
    const bwdUse = new Array(edges.length).fill(0);
    rings.forEach((ring, r) => {
        for (const ref of ring) {
            const ei = refEdge(ref);
            if (ei < 0 || ei >= edges.length) { err(`region ${name(r)} references missing edge ${ei}`); continue; }
            if (refForward(ref)) {
                fwdUse[ei]++;
                if (edges[ei].a !== r) err(`edge ${ei} used forward by ${name(r)} but belongs to ${name(edges[ei].a)}`);
            } else {
                bwdUse[ei]++;
                if (edges[ei].b !== r) err(`edge ${ei} used backward by ${name(r)} but its back side is ${edges[ei].b}`);
            }
        }
    });
    edges.forEach((e, ei) => {
        if (fwdUse[ei] !== 1) err(`edge ${ei} is used forward ${fwdUse[ei]} times (non-manifold)`);
        if (bwdUse[ei] !== (e.b >= 0 ? 1 : 0)) err(`edge ${ei} is used backward ${bwdUse[ei]} times (non-manifold)`);
    });
    if (errors.length) return { errors, warnings: warn };

    // rings: closed, simple, positive
    const regionRings = rings.map((ring, r) => {
        const pts = [];
        for (let k = 0; k < ring.length; k++) {
            const ref = ring[k];
            const e = edges[refEdge(ref)];
            const ids = refForward(ref) ? e.v : e.v.slice().reverse();
            const nextRef = ring[(k + 1) % ring.length];
            const ne = edges[refEdge(nextRef)];
            const nextStart = refForward(nextRef) ? ne.v[0] : ne.v[ne.v.length - 1];
            if (ids[ids.length - 1] !== nextStart) err(`region ${name(r)} ring is open after edge ${refEdge(ref)}`);
            for (let i = 0; i < ids.length - 1; i++) pts.push(vertices[ids[i]]);
        }
        return pts;
    });
    if (errors.length) return { errors, warnings: warn };
    regionRings.forEach((pts, r) => {
        if (signedArea(pts) <= 0) err(`region ${name(r)} has non-positive area / wrong orientation`);
        if (!isSimpleRing(pts)) err(`region ${name(r)} boundary self-intersects`);
    });

    // planarity: no two edges cross or come closer than minGap except at shared vertices
    const segs = [];
    edges.forEach((e, ei) => {
        for (let i = 0; i < e.v.length - 1; i++) segs.push({ ei, i, p: e.v[i], q: e.v[i + 1] });
    });
    const CELL = 24;
    const grid = new Map();
    segs.forEach((s, si) => {
        const [ax, ay] = vertices[s.p];
        const [bx, by] = vertices[s.q];
        const gx0 = Math.floor((Math.min(ax, bx) - minGap) / CELL);
        const gx1 = Math.floor((Math.max(ax, bx) + minGap) / CELL);
        const gy0 = Math.floor((Math.min(ay, by) - minGap) / CELL);
        const gy1 = Math.floor((Math.max(ay, by) + minGap) / CELL);
        for (let gx = gx0; gx <= gx1; gx++) {
            for (let gy = gy0; gy <= gy1; gy++) {
                const k = `${gx},${gy}`;
                if (!grid.has(k)) grid.set(k, []);
                grid.get(k).push(si);
            }
        }
    });
    const isEnd = (ei, v) => v === edges[ei].v[0] || v === edges[ei].v[edges[ei].v.length - 1];
    const checked = new Set();
    let crossings = 0;
    for (const bucket of grid.values()) {
        for (let x = 0; x < bucket.length; x++) {
            for (let y = x + 1; y < bucket.length; y++) {
                const si = bucket[x];
                const sj = bucket[y];
                const key = si < sj ? si * 100000 + sj : sj * 100000 + si;
                if (checked.has(key)) continue;
                checked.add(key);
                const s = segs[si];
                const t = segs[sj];
                const shared = s.p === t.p || s.p === t.q || s.q === t.p || s.q === t.q;
                const A = vertices[s.p];
                const B = vertices[s.q];
                const C = vertices[t.p];
                const D = vertices[t.q];
                if (shared) {
                    const sharedId = s.p === t.p || s.p === t.q ? s.p : s.q;
                    // a junction joins logical edges at both of their ends; a vertex inside an
                    // edge is shared only by that edge's neighbouring segment, otherwise two
                    // boundaries cross or touch there under a reused vertex id
                    const junction = s.ei === t.ei
                        ? Math.abs(s.i - t.i) === 1 || isEnd(s.ei, sharedId)
                        : isEnd(s.ei, sharedId) && isEnd(t.ei, sharedId);
                    if (!junction) {
                        if (crossings++ < 6) err(`edges ${s.ei} and ${t.ei} meet inside an edge at vertex ${sharedId}`);
                        continue;
                    }
                    // sharing an end is fine unless the segments fold back onto each other
                    const far1 = sharedId === s.p ? B : A;
                    const far2 = sharedId === t.p ? D : C;
                    const o = vertices[sharedId];
                    const cross = (far1[0] - o[0]) * (far2[1] - o[1]) - (far1[1] - o[1]) * (far2[0] - o[0]);
                    const dot = (far1[0] - o[0]) * (far2[0] - o[0]) + (far1[1] - o[1]) * (far2[1] - o[1]);
                    if (Math.abs(cross) < 1e-9 && dot > 0) { err(`edges ${s.ei} and ${t.ei} overlap`); crossings++; }
                    continue;
                }
                if (segmentsTouch(A, B, C, D)) {
                    if (crossings++ < 6) err(`edges ${s.ei} and ${t.ei} cross near (${A[0]},${A[1]})`);
                } else if (segmentDistance(A, B, C, D) < minGap) {
                    if (crossings++ < 6) err(`edges ${s.ei} and ${t.ei} nearly touch near (${A[0]},${A[1]}) — crack or overlap`);
                }
            }
        }
    }
    if (errors.length) return { errors, warnings: warn };

    // labels, nesting
    const regions = regionRings.map((pts, r) => {
        const pole = polylabel(pts, 0.5);
        return {
            index: r,
            points: pts,
            area: signedArea(pts),
            pole,
            bbox: bbox(pts),
        };
    });
    regions.forEach(reg => {
        for (const other of regions) {
            if (other === reg) continue;
            if (pointInRing([reg.pole.x, reg.pole.y], other.points)) err(`region ${name(reg.index)} lies inside ${name(other.index)}`);
        }
    });

    // adjacency from shared edges only
    const pairInfo = new Map();
    edges.forEach((e, ei) => {
        if (e.b < 0) return;
        const i = Math.min(e.a, e.b);
        const j = Math.max(e.a, e.b);
        const key = `${i}|${j}`;
        if (!pairInfo.has(key)) pairInfo.set(key, { i, j, edges: [], length: 0 });
        const info = pairInfo.get(key);
        info.edges.push(ei);
        info.length += edgeLength(edgePts[ei]);
    });
    const adj = Array.from({ length: n }, () => []);
    for (const { i, j, length } of pairInfo.values()) {
        adj[i].push(j);
        adj[j].push(i);
        if (length < minShared) err(`regions ${name(i)} and ${name(j)} share only ${length.toFixed(1)} units of border`);
    }
    adj.forEach(list => list.sort((x, y) => x - y));

    // corner-only contacts
    const regionsAtVertex = new Map();
    rings.forEach((ring, r) => {
        for (const ref of ring) {
            const e = edges[refEdge(ref)];
            for (const v of [e.v[0], e.v[e.v.length - 1]]) {
                if (!regionsAtVertex.has(v)) regionsAtVertex.set(v, new Set());
                regionsAtVertex.get(v).add(r);
            }
        }
    });
    const cornerContacts = [];
    for (const [v, set] of regionsAtVertex) {
        const list = [...set].sort((x, y) => x - y);
        for (let x = 0; x < list.length; x++) {
            for (let y = x + 1; y < list.length; y++) {
                if (!pairInfo.has(`${list[x]}|${list[y]}`)) cornerContacts.push([list[x], list[y], v]);
            }
        }
    }
    if (cornerContacts.length && !allowCornerContacts) {
        for (const [i, j] of cornerContacts) err(`regions ${name(i)} and ${name(j)} touch only at a corner`);
    }

    for (const reg of regions) {
        if (reg.pole.d < minInradius) err(`region ${name(reg.index)} inscribed radius ${reg.pole.d.toFixed(1)} < ${minInradius}`);
    }

    if (errors.length) return { errors, warnings: warn };

    // runtime projections
    const regionPaths = regions.map(reg => pathFromPoints(reg.points));
    const sharedEdges = [];
    for (const { i, j, edges: list } of [...pairInfo.values()].sort((p, q) => p.i - q.i || p.j - q.j)) {
        sharedEdges.push({ a: i, b: j, d: list.map(ei => pathFromPoints(edgePts[ei], false)).join(' ') });
    }
    const outline = edges.map((e, ei) => pathFromPoints(edgePts[ei], false)).join(' ');
    const coast = edges.filter(e => e.b === -2).map(e => pathFromPoints(e.v.map(id => vertices[id]), false)).join(' ');
    const all = regions.flatMap(r => r.points);
    return {
        errors,
        warnings: warn,
        adj,
        regions,
        regionPaths,
        sharedEdges,
        outline,
        coast,
        cornerContacts,
        pairInfo,
        bbox: bbox(all),
    };
}
