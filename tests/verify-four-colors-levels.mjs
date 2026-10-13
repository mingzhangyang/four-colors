// Content verifier for the 32 main pages and 8 short stories. Every claim is
// re-checked from the compiled runtime data with code that is independent of
// the generator and of the solver under test: adjacency is re-derived from
// the region paths, small chromatic claims are brute-forced, swap optimality
// uses its own breadth-first search, and geometry is sampled on a grid.

import assert from 'node:assert/strict';
import { test, run } from './lib/harness.mjs';
import { levelChecksum } from '../src/content/checksum.js';
import index from '../src/content/generated/index.js';
import { ART_SAMPLES, ART_ENVELOPE_RADIUS, artworkFor, borderPaths } from '../src/render/scenery.js';

const chapters = await Promise.all([1, 2, 3, 4].map(n => import(`../src/content/generated/chapter-${n}.js`).then(m => m.default)));
const MAIN = chapters.flat();
const STORIES = (await import('../src/content/generated/stories.js')).default;
const ALL = [...MAIN, ...STORIES];
const byId = id => ALL.find(l => l.id === id);
const E = -1;

// ── independent geometry helpers ──
function parsePath(d) {
    return d.replace(/[MZ]/g, ' ').trim().split(/\s+/).map(p => p.split(',').map(Number));
}

function adjacencyFromPaths(paths) {
    const segOwners = new Map();
    const polys = paths.map(parsePath);
    polys.forEach((pts, r) => {
        for (let i = 0; i < pts.length; i++) {
            const a = pts[i].join(',');
            const b = pts[(i + 1) % pts.length].join(',');
            const key = a < b ? `${a}|${b}` : `${b}|${a}`;
            if (!segOwners.has(key)) segOwners.set(key, new Set());
            segOwners.get(key).add(r);
        }
    });
    const adj = paths.map(() => new Set());
    for (const owners of segOwners.values()) {
        const list = [...owners];
        assert.ok(list.length <= 2, 'a boundary segment belongs to at most two regions');
        if (list.length === 2) { adj[list[0]].add(list[1]); adj[list[1]].add(list[0]); }
    }
    return { adj: adj.map(s => [...s].sort((x, y) => x - y)), polys };
}

function cornerOnlyPairs(polys, adj) {
    const at = new Map();
    polys.forEach((pts, r) => pts.forEach(p => {
        const k = p.join(',');
        if (!at.has(k)) at.set(k, new Set());
        at.get(k).add(r);
    }));
    const out = new Set();
    for (const set of at.values()) {
        const l = [...set];
        for (let i = 0; i < l.length; i++) for (let j = i + 1; j < l.length; j++) {
            if (!adj[l[i]].includes(l[j])) out.add(`${Math.min(l[i], l[j])}-${Math.max(l[i], l[j])}`);
        }
    }
    return [...out];
}

function inside([x, y], pts) {
    let c = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i];
        const [xj, yj] = pts[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
}

function distToBoundary([x, y], pts) {
    let d = Infinity;
    for (let i = 0; i < pts.length; i++) {
        const [ax, ay] = pts[i];
        const [bx, by] = pts[(i + 1) % pts.length];
        const dx = bx - ax;
        const dy = by - ay;
        const l2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
        d = Math.min(d, Math.hypot(ax + t * dx - x, ay + t * dy - y));
    }
    return d;
}

// ── independent coloring helpers ──
function proper(adj, colors) {
    return adj.every((list, i) => colors[i] >= 0 && list.every(j => colors[j] !== colors[i]));
}

function bruteForce(adj, k, preset, limit = 1) {
    const n = adj.length;
    const order = [...Array(n).keys()].sort((a, b) => adj[b].length - adj[a].length);
    const colors = preset ? preset.slice() : new Array(n).fill(E);
    let found = 0;
    let first = null;
    (function rec(pos) {
        if (found >= limit) return;
        if (pos === n) { found++; if (!first) first = colors.slice(); return; }
        const v = order[pos];
        if (colors[v] !== E) {
            if (adj[v].some(u => colors[u] === colors[v])) return;
            rec(pos + 1);
            return;
        }
        for (let c = 0; c < k; c++) {
            if (adj[v].some(u => colors[u] === c)) continue;
            colors[v] = c;
            rec(pos + 1);
            colors[v] = E;
        }
    })(0);
    return { found, first };
}

function component(adj, colors, start, a, b) {
    const seen = new Set([start]);
    const stack = [start];
    while (stack.length) {
        const v = stack.pop();
        for (const u of adj[v]) if (!seen.has(u) && (colors[u] === a || colors[u] === b)) { seen.add(u); stack.push(u); }
    }
    return [...seen];
}

function swapBfs(adj, start, locked, goal, { pairs = null, maxStates = 400000 } = {}) {
    const key = s => s.join('');
    const seen = new Map([[key(start), null]]);
    let frontier = [start];
    for (let depth = 1; frontier.length; depth++) {
        const next = [];
        for (const s of frontier) {
            for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) {
                if (pairs && !pairs.some(([x, y]) => x === a && y === b)) continue;
                const done = new Set();
                for (let v = 0; v < adj.length; v++) {
                    if (done.has(v) || (s[v] !== a && s[v] !== b)) continue;
                    const comp = component(adj, s, v, a, b);
                    comp.forEach(u => done.add(u));
                    if (comp.some(u => locked[u])) continue;
                    const t = s.slice();
                    for (const u of comp) t[u] = s[u] === a ? b : a;
                    const k = key(t);
                    if (seen.has(k)) continue;
                    seen.set(k, { prev: key(s), size: comp.length });
                    if (goal(t)) {
                        const sizes = [];
                        let cur = k;
                        while (seen.get(cur)) { sizes.unshift(seen.get(cur).size); cur = seen.get(cur).prev; }
                        return { distance: depth, sizes };
                    }
                    if (seen.size > maxStates) return { distance: null, budget: true };
                    next.push(t);
                }
            }
        }
        frontier = next;
    }
    return { distance: null, exhausted: true };
}

const startColors = lv => lv.adj.map((_, i) => (lv.fixed[i] !== E ? lv.fixed[i] : lv.initial ? lv.initial[i] : E));
const swapOnly = lv => lv.actions.length === 1 && lv.actions[0] === 'swap';

// ── inventory ──
test('launch inventory: 32 main pages in 4 chapters of 8, and 8 short stories', () => {
    assert.equal(MAIN.length, 32);
    for (let ch = 1; ch <= 4; ch++) assert.equal(MAIN.filter(l => l.chapter === ch).length, 8);
    assert.equal(STORIES.length, 8);
    assert.equal(STORIES.filter(swapOnly).length, 4, 'four swap-only stories');
    assert.equal(STORIES.filter(l => l.goals.maxColors).length, 4, 'four fewer-color stories');
    assert.deepEqual(index.main.map(e => e.id), MAIN.map(l => l.id));
    assert.deepEqual(MAIN.map(l => l.id), Array.from({ length: 32 }, (_, i) => `FC${String(i + 1).padStart(2, '0')}`));
});

test('every level matches its checksum and index entry', () => {
    for (const lv of ALL) {
        assert.equal(levelChecksum(lv), lv.checksum, lv.id);
        const entry = [...index.main, ...index.stories].find(e => e.id === lv.id);
        assert.equal(entry.checksum, lv.checksum);
        assert.equal(entry.revision, lv.revision);
    }
});

test('chapter region ranges (FC26 is the documented 4-region swap sample)', () => {
    const ranges = { 1: [4, 9], 2: [8, 14], 3: [12, 18], 4: [14, 22] };
    for (const lv of MAIN) {
        if (lv.id === 'FC26') { assert.equal(lv.adj.length, 4); continue; }
        const [lo, hi] = ranges[lv.chapter];
        assert.ok(lv.adj.length >= lo && lv.adj.length <= hi, `${lv.id} has ${lv.adj.length} regions`);
    }
    for (const lv of ALL) assert.ok(lv.adj.length <= 22, `${lv.id} stays within 22 regions`);
});

// ── geometry ──
test('adjacency re-derived from region paths equals the compiled table (all views)', () => {
    for (const lv of ALL) {
        const { adj } = adjacencyFromPaths(lv.paths);
        assert.deepEqual(adj, lv.adj, `${lv.id} adjacency`);
        for (const v of lv.views) assert.deepEqual(adjacencyFromPaths(v.paths).adj, lv.adj, `${lv.id} alternate view keeps structure`);
        assert.equal(new Set(lv.ids).size, lv.ids.length, `${lv.id} ids are unique`);
    }
});

test('corner-only contacts appear only where the page teaches them', () => {
    for (const lv of ALL) {
        const { adj, polys } = adjacencyFromPaths(lv.paths);
        const corners = cornerOnlyPairs(polys, adj);
        if (lv.id === 'FC03' || lv.id === 'S7') continue;
        assert.deepEqual(corners, [], `${lv.id} corner contacts`);
    }
    const fc03 = byId('FC03');
    const { adj, polys } = adjacencyFromPaths(fc03.paths);
    assert.deepEqual(adj, [[1, 3], [0, 2], [1, 3], [0, 2]], 'FC03 is a 4-cycle, no diagonal edges');
    assert.deepEqual(cornerOnlyPairs(polys, adj).sort(), ['0-2', '1-3']);
});

test('no overlaps or gaps: grid samples fall in at most one region (and land has no holes)', () => {
    for (const lv of ALL) {
        const polys = lv.paths.map(parsePath);
        const [bx, by, bw, bh] = lv.box;
        let misses = 0;
        for (let x = bx + 3; x < bx + bw; x += 7) {
            for (let y = by + 3; y < by + bh; y += 7) {
                const p = [x, y];
                let n = 0;
                let near = false;
                for (const pts of polys) {
                    if (distToBoundary(p, pts) < 1.2) { near = true; break; }
                    if (inside(p, pts)) n++;
                }
                if (near) continue;
                assert.ok(n <= 1, `${lv.id}: overlapping regions at ${x},${y}`);
                if (n === 0) misses++;
            }
        }
        if (!lv.water && lv.id !== 'FC08' && lv.id !== 'FC24') {
            // margins outside the page frame are the only allowed blanks
            const frameArea = (bw - 12) * (bh - 12);
            assert.ok(misses * 49 < frameArea * 0.06, `${lv.id}: unexpected gaps (${misses} samples)`);
        }
    }
});

test('touch floor: every region has a generous interior around its label point', () => {
    for (const lv of ALL) {
        const polys = lv.paths.map(parsePath);
        lv.labels.forEach(([x, y, r], i) => {
            assert.ok(inside([x, y], polys[i]), `${lv.id} label ${lv.ids[i]} lies inside its region`);
            const d = distToBoundary([x, y], polys[i]);
            assert.ok(Math.abs(d - r) < 1.5, `${lv.id} recorded radius matches geometry`);
            assert.ok(d >= (lv.id === 'FC24' ? 19.5 : 23.5), `${lv.id} ${lv.ids[i]} inscribed radius ${d.toFixed(1)}`);
        });
    }
});

test('landmarks sit inside regions, away from borders, never on stamps', () => {
    for (const lv of ALL) {
        const polys = lv.paths.map(parsePath);
        const targets = new Set((lv.goals.targets || []).map(([i]) => i));
        for (const [i, , x, y, s] of lv.art) {
            assert.ok(inside([x, y], polys[i]), `${lv.id} landmark inside ${lv.ids[i]}`);
            assert.ok(distToBoundary([x, y], polys[i]) >= 14 * s, `${lv.id} landmark clear of the border`);
            assert.equal(lv.fixed[i], E, `${lv.id} landmark not on a fixed stamp`);
            assert.ok(!targets.has(i));
        }
    }
});

test('no padding with trivial leaves (at most one degree-1 region; none isolated)', () => {
    for (const lv of ALL) {
        const deg = lv.adj.map(l => l.length);
        assert.ok(deg.every(d => d > 0), `${lv.id} isolated region`);
        const leaves = deg.filter(d => d === 1).length;
        if (lv.id === 'FC26') continue;
        assert.ok(leaves <= (lv.id === 'FC24' ? 2 : 1), `${lv.id} has ${leaves} leaves`);
    }
});

// ── certificates ──
test('every witness is a valid completion (rules re-checked independently)', () => {
    for (const lv of ALL) {
        const w = lv.witness;
        assert.equal(w.length, lv.adj.length);
        assert.ok(proper(lv.adj, w), `${lv.id} witness proper`);
        lv.fixed.forEach((c, i) => { if (c !== E) assert.equal(w[i], c, `${lv.id} witness keeps fixed ${lv.ids[i]}`); });
        for (const [i, c] of lv.goals.targets || []) assert.equal(w[i], c, `${lv.id} witness meets target`);
        if (lv.goals.maxColors) assert.ok(new Set(w).size <= lv.goals.maxColors, `${lv.id} witness color count`);
        if (lv.initial) lv.fixed.forEach((c, i) => { if (c !== E) assert.equal(lv.initial[i], E); });
    }
});

test('Chapter 1 pages FC01–FC07 really are three-colorable; FC03 two-colorable', () => {
    for (const lv of MAIN.filter(l => l.chapter === 1 && l.id !== 'FC08')) {
        assert.equal(bruteForce(lv.adj, 3).found, 1, `${lv.id} 3-colorable`);
    }
    assert.equal(bruteForce(byId('FC03').adj, 2).found, 1);
});

test('FC08 is K4: four colors suffice and three cannot', () => {
    const lv = byId('FC08');
    assert.deepEqual(lv.adj, [[1, 2, 3], [0, 2, 3], [0, 1, 3], [0, 1, 2]]);
    assert.equal(bruteForce(lv.adj, 3).found, 0);
    assert.equal(bruteForce(lv.adj, 4).found, 1);
});

test('FC16: legal ring blocks the centre, rearranged ring frees it, no fixed ring colors', () => {
    const lv = byId('FC16');
    const X = lv.ids.indexOf('X');
    const ring = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6'].map(id => lv.ids.indexOf(id));
    assert.deepEqual(ring.map(i => lv.initial[i]), [0, 1, 2, 3, 0, 1]);
    assert.ok(ring.every(i => lv.fixed[i] === E));
    assert.deepEqual([...lv.adj[X]].sort(), [...ring].sort());
    const start = startColors(lv);
    assert.ok(lv.adj.every((l, i) => start[i] === E || l.every(j => start[j] !== start[i])), 'ring has no conflict');
    assert.equal(bruteForce(lv.adj, 4, start).found, 0, 'cannot fill the centre without rearranging');
    const fixedRing = lv.adj.map(() => E);
    ring.forEach((i, k) => { fixedRing[i] = k % 2; });
    fixedRing[X] = 2;
    assert.equal(bruteForce(lv.adj, 4, fixedRing).found, 1);
});

test('FC23 and FC24: same structure, different geometry', () => {
    const fc23 = byId('FC23');
    assert.equal(fc23.views.length, 1);
    assert.notDeepEqual(fc23.views[0].paths, fc23.paths);
    const fc24 = byId('FC24');
    const m = fc24.adj.length / 2;
    for (let i = 0; i < m; i++) {
        assert.ok(fc24.adj[i].every(j => j < m), 'maps are separate');
        assert.deepEqual(fc24.adj[i + m].map(j => j - m), fc24.adj[i], 'region i maps to i+m');
    }
});

test('fewer-color stories have witnesses with that many colors and need them', () => {
    for (const lv of STORIES.filter(l => l.goals.maxColors)) {
        const k = lv.goals.maxColors;
        assert.ok(new Set(lv.witness).size <= k);
        assert.equal(bruteForce(lv.adj, k - 1, startColors(lv).map((c, i) => (lv.fixed[i] !== E ? c : E))).found, 0, `${lv.id} cannot use fewer than ${k}`);
    }
});

test('swap-only pages start fully and properly colored; optimal swap counts verified by BFS', () => {
    for (const lv of ALL.filter(swapOnly)) {
        const start = startColors(lv);
        assert.ok(proper(lv.adj, start), `${lv.id} starts as a proper complete coloring`);
        const locked = lv.fixed.map(c => c !== E);
        const goal = s => lv.goals.targets.every(([i, c]) => s[i] === c);
        assert.ok(!goal(start), `${lv.id} is not already solved`);
        const r = swapBfs(lv.adj, start, locked, goal);
        assert.equal(r.distance, lv.goals.optimalSwaps, `${lv.id} optimal swaps`);
        if (lv.id !== 'FC26') {
            assert.ok(r.distance >= 2, `${lv.id} cannot be finished by one swap (no one-tap full-page swap)`);
            assert.ok(r.sizes.some(s => s >= 2), `${lv.id} includes a multi-region change`);
        }
    }
    const s1 = byId('S1');
    const start = startColors(s1);
    const locked = s1.fixed.map(c => c !== E);
    const goal = s => s1.goals.targets.every(([i, c]) => s[i] === c);
    for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) {
        const r = swapBfs(s1.adj, start, locked, goal, { pairs: [[a, b]] });
        assert.equal(r.distance, null, `S1 must not be solvable with only ${a}/${b}`);
    }
});

test('blocked-region swap pages: a hole sees all four colors and a swap frees it', () => {
    for (const lv of MAIN.filter(l => l.initial && l.actions.includes('swap') && !swapOnly(l))) {
        const start = startColors(lv);
        const holes = start.map((c, i) => (c === E ? i : -1)).filter(i => i >= 0);
        if (!lv.tags.includes('prefilled') || holes.length > 3) continue;
        for (const h of holes) {
            const seen = new Set(lv.adj[h].map(j => start[j]).filter(c => c !== E));
            assert.equal(seen.size, 4, `${lv.id} ${lv.ids[h]} is blocked`);
        }
        const locked = lv.fixed.map(c => c !== E);
        const goal = s => holes.every(h => new Set(lv.adj[h].map(j => s[j])).size < 4);
        const r = swapBfs(lv.adj, start, locked, goal, { maxStates: 50000 });
        assert.ok(r.distance !== null && r.distance <= 2, `${lv.id} swap frees the hole`);
    }
});

test('prefilled trap pages are conflict-free yet cannot be finished without repainting', () => {
    for (const lv of ALL.filter(l => l.tags.includes('prefilled') && !l.actions.includes('swap'))) {
        const start = startColors(lv);
        assert.ok(lv.adj.every((l, i) => start[i] === E || l.every(j => start[j] !== start[i])), `${lv.id} no initial conflict`);
        assert.equal(bruteForce(lv.adj, 4, start).found, 0, `${lv.id} needs a rearrangement`);
    }
    for (const lv of ALL.filter(l => l.tags.includes('prefilled') && l.actions.includes('swap') && !swapOnly(l))) {
        const start = startColors(lv);
        assert.equal(bruteForce(lv.adj, 4, start).found, 0, `${lv.id} needs a rearrangement`);
    }
});

test('water is declared as background in the legend data', () => {
    for (const lv of ALL.filter(l => l.water)) assert.ok(lv.coast.length > 0, `${lv.id} has a coastline`);
});

test('art direction preserves every compiled edge exactly once', () => {
    const parts = d => (d.match(/M[^M]+/g) || []).map(s => s.trim()).sort();
    for (const lv of ALL) for (const view of [lv, ...lv.views]) {
        const { inner, outer } = borderPaths(view);
        assert.deepEqual(parts(`${inner} ${outer}`), parts(view.outline), `${lv.id} edge partition`);
    }
});

test('sample illustrations stay inside regions and away from seals and targets', () => {
    for (const id of ART_SAMPLES) {
        const lv = byId(id);
        for (const view of [lv, ...lv.views]) {
            const art = artworkFor(lv, view);
            assert.ok(art.length > 0, `${id} has scenery in every view`);
            for (const { region, x, y, scale } of art) {
                assert.equal(lv.fixed[region], E);
                assert.ok(!(lv.goals.targets || []).some(([i]) => i === region));
                const polygon = parsePath(view.paths[region]);
                assert.ok(inside([x, y], polygon));
                assert.ok(distToBoundary([x, y], polygon) > ART_ENVELOPE_RADIUS * scale, `${id} artwork clears its boundary`);
            }
        }
    }
});

await run('verify-four-colors-levels');
