// Procedural atlas pages: clipped Voronoi cells, optional painted water, and
// regions grown as connected unions of cells. Everything is seeded and
// deterministic; callers retry with the next attempt number when a page fails
// the compiler's checks.

import { voronoiCells, relax, spreadSites } from './voronoi.mjs';
import { signedArea, centroid, mulberry32, hashSeed } from './geometry.mjs';
import { WATER } from './mesh-build.mjs';

export function rectRing([x0, y0, x1, y1]) {
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

function cellNeighbours(cells) {
    // shared length per neighbour, from the labelled Voronoi edges
    return cells.map(cell => {
        const map = new Map();
        const m = cell.ring.length;
        for (let k = 0; k < m; k++) {
            const j = cell.labels[k];
            if (j < 0) continue;
            const p = cell.ring[k];
            const q = cell.ring[(k + 1) % m];
            const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
            if (len < 1e-6) continue;
            map.set(j, (map.get(j) || 0) + len);
        }
        return map;
    });
}

const WATER_SHAPES = {
    coast(frame, rng) {
        const [x0, y0, x1, y1] = frame;
        const side = Math.floor(rng() * 3); // 0 bottom, 1 left, 2 right
        const depth = 0.18 + rng() * 0.12;
        const ph = rng() * 6.28;
        const amp = 0.05 + rng() * 0.05;
        return ([x, y]) => {
            if (side === 0) {
                const t = (x - x0) / (x1 - x0);
                return (y - y0) / (y1 - y0) > 1 - depth + amp * Math.sin(t * 7 + ph);
            }
            const t = (y - y0) / (y1 - y0);
            const u = (x - x0) / (x1 - x0);
            const edge = depth * 0.9 + amp * Math.sin(t * 6 + ph);
            return side === 1 ? u < edge : u > 1 - edge;
        };
    },
    bay(frame, rng) {
        const [x0, y0, x1, y1] = frame;
        const cx = x0 + (0.3 + rng() * 0.4) * (x1 - x0);
        const r = 0.28 + rng() * 0.08;
        return ([x, y]) => {
            const u = (x - cx) / (x1 - x0);
            const v = (y - y1) / (y1 - y0);
            return u * u + v * v < r * r;
        };
    },
    strait(frame, rng) {
        // a channel with no crossing: the land falls apart into two islands
        const [x0, y0, x1, y1] = frame;
        const ph = rng() * 6.28;
        const mid = 0.45 + rng() * 0.1;
        const tilt = (rng() - 0.5) * 0.3;
        const width = 0.075 + rng() * 0.015;
        return ([x, y]) => {
            const t = (x - x0) / (x1 - x0);
            const v = (y - y0) / (y1 - y0);
            const centre = mid + tilt * (t - 0.5) + 0.07 * Math.sin(t * 4.5 + ph);
            return Math.abs(v - centre) < width || t > 0.93 || t < 0.04;
        };
    },
    river(frame, rng) {
        const [x0, y0, x1, y1] = frame;
        const ph = rng() * 6.28;
        const mid = 0.4 + rng() * 0.2;
        const width = 0.055 + rng() * 0.02;
        const bridges = [0.25 + rng() * 0.15, 0.62 + rng() * 0.15];
        return ([x, y]) => {
            const t = (x - x0) / (x1 - x0);
            const centre = mid + 0.12 * Math.sin(t * 5 + ph);
            const v = (y - y0) / (y1 - y0);
            if (bridges.some(b => Math.abs(t - b) < 0.06)) return false;
            return Math.abs(v - centre) < width;
        };
    },
    pond(frame, rng) {
        const [x0, y0, x1, y1] = frame;
        const cx = x0 + (0.42 + rng() * 0.16) * (x1 - x0);
        const cy = y0 + (0.42 + rng() * 0.16) * (y1 - y0);
        const r = 48 + rng() * 14;
        return ([x, y]) => Math.hypot(x - cx, (y - cy) * 0.9) < r;
    },
};

/**
 * Generate a page.
 * spec: { seed, attempt, regions, cells, frame, relax, stretch, water }
 * returns { cells: [{ ring, region }], regionCount } or throws on impossible growth.
 */
export function voronoiPage(spec) {
    const {
        seed,
        attempt = 0,
        regions,
        cells: cellCount = regions * 3,
        frame = [20, 20, 460, 620],
        relax: relaxIters = 2,
        stretch = [1, 1],
        water = null,
    } = spec;
    const rng = mulberry32(hashSeed('page', seed, attempt));
    const [sx, sy] = stretch;
    const sFrame = [frame[0] * sx, frame[1] * sy, frame[2] * sx, frame[3] * sy];
    const sRing = rectRing(sFrame);
    let sites = spreadSites(cellCount, sFrame, rng, 10);
    if (relaxIters) sites = relax(sites, sRing, relaxIters);
    const raw = voronoiCells(sites, sRing);
    const cells = raw.map(c => ({ ring: c.ring.map(([x, y]) => [x / sx, y / sy]), labels: c.labels }));
    const sitePts = sites.map(([x, y]) => [x / sx, y / sy]);
    const nb = cellNeighbours(cells);
    const areas = cells.map(c => Math.abs(signedArea(c.ring)));

    // water
    const isWater = new Uint8Array(cells.length);
    if (water) {
        const fn = WATER_SHAPES[water](frame, rng);
        cells.forEach((c, i) => { if (fn(centroid(c.ring))) isWater[i] = 1; });
    }

    // land components
    const comp = new Int32Array(cells.length).fill(-1);
    const comps = [];
    for (let i = 0; i < cells.length; i++) {
        if (isWater[i] || comp[i] !== -1) continue;
        const list = [i];
        comp[i] = comps.length;
        for (let h = 0; h < list.length; h++) {
            for (const j of nb[list[h]].keys()) {
                if (!isWater[j] && comp[j] === -1) { comp[j] = comps.length; list.push(j); }
            }
        }
        comps.push(list);
    }
    if (water === 'strait' && comps.filter(c => c.length >= 4).length !== 2) throw new Error('not two islands of land');
    const landCells = comps.reduce((s, c) => s + c.length, 0);
    if (landCells < regions) throw new Error('not enough land');
    // allocate seeds per component
    let alloc = comps.map(c => Math.max(1, Math.round((regions * c.length) / landCells)));
    alloc = alloc.map((a, i) => Math.min(a, comps[i].length));
    let total = alloc.reduce((s, a) => s + a, 0);
    const order = comps.map((c, i) => i).sort((a, b) => comps[b].length - comps[a].length);
    for (let guard = 0; total !== regions && guard < 200; guard++) {
        const i = order[guard % order.length];
        if (total < regions && alloc[i] < comps[i].length) { alloc[i]++; total++; }
        else if (total > regions && alloc[i] > 1) { alloc[i]--; total--; }
    }
    if (total !== regions) throw new Error('cannot allocate regions');

    const assign = new Int32Array(cells.length).fill(-1);
    const regionArea = [];
    let r = 0;
    comps.forEach((list, ci) => {
        const seeds = [list[Math.floor(rng() * list.length)]];
        while (seeds.length < alloc[ci]) {
            let best = -1;
            let bestD = -1;
            for (const c of list) {
                if (seeds.includes(c)) continue;
                let d = Infinity;
                for (const s of seeds) d = Math.min(d, Math.hypot(sitePts[c][0] - sitePts[s][0], sitePts[c][1] - sitePts[s][1]));
                d *= 0.85 + rng() * 0.3;
                if (d > bestD) { bestD = d; best = c; }
            }
            seeds.push(best);
        }
        for (const s of seeds) {
            assign[s] = r;
            regionArea[r] = areas[s];
            r++;
        }
    });

    // grow
    let remaining = landCells - regions;
    while (remaining > 0) {
        const candidates = [];
        for (let reg = 0; reg < regions; reg++) {
            let bestCell = -1;
            let bestScore = -1;
            for (let c = 0; c < cells.length; c++) {
                if (assign[c] !== reg) continue;
                for (const [j, len] of nb[c]) {
                    if (isWater[j] || assign[j] !== -1) continue;
                    let shared = 0;
                    let perim = 0;
                    for (const [k, l2] of nb[j]) {
                        perim += l2;
                        if (assign[k] === reg) shared += l2;
                    }
                    const score = shared / (perim || 1) + rng() * 0.35 + len * 0;
                    if (score > bestScore) { bestScore = score; bestCell = j; }
                }
            }
            if (bestCell !== -1) candidates.push({ reg, cell: bestCell });
        }
        if (!candidates.length) throw new Error('growth stalled');
        candidates.sort((a, b) => regionArea[a.reg] - regionArea[b.reg]);
        const pick = candidates[Math.min(candidates.length - 1, Math.floor(rng() * rng() * 2.2))];
        assign[pick.cell] = pick.reg;
        regionArea[pick.reg] += areas[pick.cell];
        remaining--;
    }
    return {
        cells: cells.map((c, i) => ({ ring: c.ring, region: isWater[i] ? WATER : assign[i] })),
        regionCount: regions,
    };
}

/** Split the frame by straight chords; every face of a line arrangement map is 2-colorable. */
export function chordPage({ seed, attempt = 0, lines, frame = [20, 20, 460, 620] }) {
    const rng = mulberry32(hashSeed('chords', seed, attempt));
    let polys = [rectRing(frame)];
    const [x0, y0, x1, y1] = frame;
    for (let l = 0; l < lines; l++) {
        // a chord through a random interior point at a random angle
        const px = x0 + (0.2 + rng() * 0.6) * (x1 - x0);
        const py = y0 + (0.15 + rng() * 0.7) * (y1 - y0);
        const ang = rng() * Math.PI;
        const nx = Math.cos(ang);
        const ny = Math.sin(ang);
        const c = nx * px + ny * py;
        const next = [];
        for (const poly of polys) {
            const side = poly.map(p => nx * p[0] + ny * p[1] - c);
            if (side.every(s => s <= 1e-9) || side.every(s => s >= -1e-9)) { next.push(poly); continue; }
            for (const sign of [1, -1]) {
                const out = [];
                for (let k = 0; k < poly.length; k++) {
                    const P = poly[k];
                    const Q = poly[(k + 1) % poly.length];
                    const sp = sign * side[k];
                    const sq = sign * side[(k + 1) % poly.length];
                    if (sp <= 0 && sq <= 0) out.push(Q);
                    else if (sp <= 0 && sq > 0) out.push([P[0] + (Q[0] - P[0]) * (sp / (sp - sq)), P[1] + (Q[1] - P[1]) * (sp / (sp - sq))]);
                    else if (sp > 0 && sq <= 0) {
                        out.push([P[0] + (Q[0] - P[0]) * (sp / (sp - sq)), P[1] + (Q[1] - P[1]) * (sp / (sp - sq))]);
                        out.push(Q);
                    }
                }
                if (out.length >= 3) next.push(out);
            }
        }
        polys = next;
    }
    return { cells: polys.map((ring, i) => ({ ring, region: i })), regionCount: polys.length };
}
