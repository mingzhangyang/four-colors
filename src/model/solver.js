// Small-map coloring solver: DSATUR/MRV variable choice, forward-checked
// bitmask domains and chronological backtracking. Maps in this game stay below
// ~44 regions, so no four-color-theorem machinery is needed. Every search is
// bounded by `nodeLimit`; callers must treat `exhausted === false` as
// "unknown", never as "no solution".

import { EMPTY, COLOR_COUNT } from './rules.js';

const POP = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

function popcount(mask) {
    return POP[mask & 15] + POP[(mask >> 4) & 15];
}

/**
 * Enumerate colorings.
 * @param {number[][]} adj
 * @param {object} opts
 *   k          palette size: color IDs 0…k-1 (1–4)
 *   maxColors  maximum distinct colors used from that palette (default k)
 *   preset     array of EMPTY or color: assignments that must hold
 *   limit      stop after this many solutions
 *   nodeLimit  search budget (assignments tried)
 *   rng        optional () => [0,1) for randomised value order
 *   symmetry   count colorings up to color permutation (only valid without preset)
 *   collect    keep solution arrays (default true)
 */
export function solve(adj, opts = {}) {
    const {
        k = COLOR_COUNT,
        maxColors = k,
        preset = null,
        limit = 1,
        nodeLimit = 2_000_000,
        rng = null,
        symmetry = false,
        collect = true,
    } = opts;
    const n = adj.length;
    const full = (1 << k) - 1;
    const color = new Int8Array(n).fill(EMPTY);
    const dom = new Uint8Array(n).fill(full);
    const trail = [];
    const solutions = [];
    let count = 0;
    let nodes = 0;
    let aborted = false;

    function assign(v, c) {
        color[v] = c;
        const bit = 1 << c;
        for (const u of adj[v]) {
            if (color[u] === EMPTY && (dom[u] & bit)) {
                trail.push(u, dom[u]);
                dom[u] &= ~bit;
                if (dom[u] === 0) return false;
            }
        }
        return true;
    }

    function undoTo(mark) {
        while (trail.length > mark) {
            const d = trail.pop();
            const u = trail.pop();
            dom[u] = d;
        }
    }

    if (preset) {
        if (symmetry && preset.some(c => c !== EMPTY)) {
            throw new Error('symmetry breaking is only valid without preset colors');
        }
        for (let v = 0; v < n; v++) {
            const c = preset[v];
            if (c === EMPTY || c === undefined) continue;
            if (c < 0 || c >= k || !(dom[v] & (1 << c))) {
                return { count: 0, solutions: [], exhausted: true, nodes: 0 };
            }
            if (!assign(v, c)) return { count: 0, solutions: [], exhausted: true, nodes: 0 };
        }
        // two adjacent presets with the same color are caught by the domain check above
        for (let v = 0; v < n; v++) {
            if (color[v] === EMPTY) continue;
            for (const u of adj[v]) if (color[u] === color[v]) {
                return { count: 0, solutions: [], exhausted: true, nodes: 0 };
            }
        }
    }

    function pick() {
        let best = -1;
        let bestSize = 99;
        let bestDeg = -1;
        for (let v = 0; v < n; v++) {
            if (color[v] !== EMPTY) continue;
            const size = popcount(dom[v]);
            if (size > bestSize) continue;
            let deg = 0;
            for (const u of adj[v]) if (color[u] === EMPTY) deg++;
            if (size < bestSize || deg > bestDeg) {
                best = v;
                bestSize = size;
                bestDeg = deg;
            }
        }
        return best;
    }

    function values(v, maxUsed) {
        const out = [];
        for (let c = 0; c < k; c++) {
            if (!(dom[v] & (1 << c))) continue;
            if (symmetry && c > maxUsed + 1) continue;
            out.push(c);
        }
        if (rng) {
            for (let i = out.length - 1; i > 0; i--) {
                const j = Math.floor(rng() * (i + 1));
                [out[i], out[j]] = [out[j], out[i]];
            }
        }
        return out;
    }

    function dfs(maxUsed, usedMask) {
        if (aborted || count >= limit || popcount(usedMask) > maxColors) return;
        const v = pick();
        if (v === -1) {
            count++;
            if (collect) solutions.push(Array.from(color));
            return;
        }
        for (const c of values(v, maxUsed)) {
            const nextMask = usedMask | (1 << c);
            if (popcount(nextMask) > maxColors) continue;
            if (++nodes > nodeLimit) { aborted = true; return; }
            const mark = trail.length;
            if (assign(v, c)) dfs(Math.max(maxUsed, c), nextMask);
            undoTo(mark);
            color[v] = EMPTY;
            if (aborted || count >= limit) return;
        }
    }

    dfs(-1, color.reduce((mask, c) => c === EMPTY ? mask : mask | (1 << c), 0));
    return { count, solutions, exhausted: !aborted && count < limit, nodes, aborted };
}

export function findSolution(adj, opts = {}) {
    const r = solve(adj, { ...opts, limit: 1 });
    return r.count > 0 ? r.solutions[0] : null;
}

/** Count colorings up to `cap`. `exact` is true only when the search finished below the cap. */
export function countSolutions(adj, opts = {}) {
    const cap = opts.cap ?? 1000;
    const r = solve(adj, { ...opts, limit: cap, collect: false });
    return { count: r.count, exact: r.exhausted, capped: r.count >= cap, aborted: r.aborted };
}

/** Is the current (conflict-free) partial coloring extendable to a full one? */
export function isExtendable(adj, colors, opts = {}) {
    const r = solve(adj, { ...opts, preset: colors, limit: 1, collect: true });
    return { extendable: r.count > 0, known: r.count > 0 || r.exhausted, solution: r.solutions[0] || null };
}

/**
 * For each empty region, which colors keep the map solvable.
 * Returns an array of bitmasks (0 for painted regions) or null when the budget ran out.
 */
export function viableCandidates(adj, colors, opts = {}) {
    const n = adj.length;
    const k = opts.k ?? COLOR_COUNT;
    const out = new Array(n).fill(0);
    const trial = colors.slice();
    for (let v = 0; v < n; v++) {
        if (colors[v] !== EMPTY) continue;
        for (let c = 0; c < k; c++) {
            let clash = false;
            for (const u of adj[v]) if (colors[u] === c) { clash = true; break; }
            if (clash) continue;
            trial[v] = c;
            const r = isExtendable(adj, trial, opts);
            trial[v] = EMPTY;
            if (!r.known) return null;
            if (r.extendable) out[v] |= 1 << c;
        }
    }
    return out;
}

/**
 * Branch and bound for the full solution that repaints the fewest of the
 * player's current (non-fixed) regions. `fixed` regions never change.
 */
export function nearestSolution(adj, colors, opts = {}) {
    const { k = COLOR_COUNT, maxColors = k, fixed = null, nodeLimit = 400_000 } = opts;
    const n = adj.length;
    const full = (1 << k) - 1;
    const color = new Int8Array(n).fill(EMPTY);
    const dom = new Uint8Array(n).fill(full);
    const trail = [];
    let best = null;
    let bestCost = Infinity;
    let nodes = 0;
    let aborted = false;

    function assign(v, c) {
        color[v] = c;
        const bit = 1 << c;
        for (const u of adj[v]) {
            if (color[u] === EMPTY && (dom[u] & bit)) {
                trail.push(u, dom[u]);
                dom[u] &= ~bit;
                if (dom[u] === 0) return false;
            }
        }
        return true;
    }
    function undoTo(mark) {
        while (trail.length > mark) {
            const d = trail.pop();
            const u = trail.pop();
            dom[u] = d;
        }
    }
    if (fixed) {
        for (let v = 0; v < n; v++) {
            if (fixed[v] === EMPTY) continue;
            if (!(dom[v] & (1 << fixed[v])) || !assign(v, fixed[v])) {
                return { solution: null, cost: Infinity, optimal: true };
            }
        }
    }
    function pick() {
        let bestV = -1;
        let bestSize = 99;
        for (let v = 0; v < n; v++) {
            if (color[v] !== EMPTY) continue;
            const size = popcount(dom[v]);
            if (size < bestSize) { bestV = v; bestSize = size; }
        }
        return bestV;
    }
    function dfs(cost, usedMask) {
        if (aborted || cost >= bestCost || popcount(usedMask) > maxColors) return;
        const v = pick();
        if (v === -1) {
            bestCost = cost;
            best = Array.from(color);
            return;
        }
        const cur = colors[v];
        const order = [];
        if (cur !== EMPTY && (dom[v] & (1 << cur))) order.push(cur);
        for (let c = 0; c < k; c++) if (c !== cur && (dom[v] & (1 << c))) order.push(c);
        for (const c of order) {
            const nextMask = usedMask | (1 << c);
            if (popcount(nextMask) > maxColors) continue;
            if (++nodes > nodeLimit) { aborted = true; return; }
            const step = cur !== EMPTY && c !== cur ? 1 : 0;
            if (cost + step >= bestCost) continue;
            const mark = trail.length;
            if (assign(v, c)) dfs(cost + step, nextMask);
            undoTo(mark);
            color[v] = EMPTY;
            if (aborted) return;
        }
    }
    dfs(0, color.reduce((mask, c) => c === EMPTY ? mask : mask | (1 << c), 0));
    return { solution: best, cost: bestCost, optimal: !aborted };
}

/** Smallest k ≤ 4 for which a coloring exists (with optional preset). */
export function chromaticNumber(adj, opts = {}) {
    for (let k = 1; k <= COLOR_COUNT; k++) {
        const r = solve(adj, { ...opts, k, limit: 1 });
        if (r.count > 0) return { k, witness: r.solutions[0], exact: true };
        if (!r.exhausted) return { k: null, witness: null, exact: false };
    }
    return { k: null, witness: null, exact: true };
}
