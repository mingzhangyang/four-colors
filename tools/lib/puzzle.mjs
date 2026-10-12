// Puzzle construction on top of a compiled map: witnesses, fixed clues,
// difficulty measures, prefilled traps, swap-only challenges and
// "blocked region" set-ups for the two-color swap. All searches are bounded;
// a budget overrun rejects the candidate instead of being read as "no solution".

import { solve, countSolutions, isExtendable, nearestSolution } from '../../src/model/solver.js';
import { shortestSwapPath, legalSwaps } from '../../src/model/kempe.js';
import { EMPTY, hasConflict } from '../../src/model/rules.js';

export function randomColoring(adj, rng, { k = 4, preset = null } = {}) {
    const r = solve(adj, { k, preset, rng, limit: 1, nodeLimit: 500_000 });
    return r.count ? r.solutions[0] : null;
}

function candidates(adj, colors, v, k) {
    let mask = 0;
    for (const u of adj[v]) if (colors[u] !== EMPTY) mask |= 1 << colors[u];
    const out = [];
    for (let c = 0; c < k; c++) if (!(mask & (1 << c))) out.push(c);
    return out;
}

/** Naked-single propagation: how far plain "only one color left" reasoning goes. */
export function propagateSingles(adj, preset, k = 4) {
    const colors = preset.slice();
    let rounds = 0;
    let changed = true;
    let contradiction = false;
    while (changed) {
        changed = false;
        const batch = [];
        for (let v = 0; v < adj.length; v++) {
            if (colors[v] !== EMPTY) continue;
            const cand = candidates(adj, colors, v, k);
            if (cand.length === 0) contradiction = true;
            if (cand.length === 1) batch.push([v, cand[0]]);
        }
        if (contradiction) break;
        for (const [v, c] of batch) {
            if (colors[v] === EMPTY && candidates(adj, colors, v, k).includes(c)) {
                colors[v] = c;
                changed = true;
            }
        }
        if (changed) rounds++;
    }
    const filled = colors.filter(c => c !== EMPTY).length;
    return { colors, rounds, filled, contradiction };
}

/** Share of random most-constrained-first playouts that paint into a dead end. */
export function trapRate(adj, preset, rng, { k = 4, playouts = 160, mrv = false } = {}) {
    let dead = 0;
    for (let p = 0; p < playouts; p++) {
        const colors = preset.slice();
        for (;;) {
            let best = -1;
            let bestCand = null;
            if (mrv) {
                for (let v = 0; v < adj.length; v++) {
                    if (colors[v] !== EMPTY) continue;
                    const cand = candidates(adj, colors, v, k);
                    if (!bestCand || cand.length < bestCand.length || (cand.length === bestCand.length && rng() < 0.3)) {
                        best = v;
                        bestCand = cand;
                    }
                }
            } else {
                // casual player: any unpainted region, but an obviously forced one is noticed half the time
                const open = [];
                for (let v = 0; v < adj.length; v++) if (colors[v] === EMPTY) open.push(v);
                if (open.length) {
                    const forced = open.filter(v => candidates(adj, colors, v, k).length <= 1);
                    best = forced.length && rng() < 0.5 ? forced[Math.floor(rng() * forced.length)] : open[Math.floor(rng() * open.length)];
                    bestCand = candidates(adj, colors, best, k);
                }
            }
            if (best === -1) break;
            if (!bestCand.length) { dead++; break; }
            colors[best] = bestCand[Math.floor(rng() * bestCand.length)];
        }
    }
    return dead / playouts;
}

export function measure(adj, preset, rng, k = 4) {
    const singles = propagateSingles(adj, preset, k);
    const sol = countSolutions(adj, { k, preset, cap: 5000, nodeLimit: 3_000_000 });
    return {
        solutions: sol.count,
        solutionsExact: sol.exact,
        singlesFilled: singles.filled,
        singlesRounds: singles.rounds,
        trapRate: Math.round(trapRate(adj, preset, rng, { k }) * 100) / 100,
        mrvTrapRate: Math.round(trapRate(adj, preset, rng, { k, mrv: true }) * 100) / 100,
    };
}

/**
 * Greedily add fixed clues taken from the witness until the clue set leaves at
 * most `maxSolutions` colorings. Returns the clue indices or null.
 */
export function chooseClues(adj, witness, { rng, maxSolutions, maxClues, minClues = 0, k = 4, avoid = [] }) {
    const n = adj.length;
    const preset = new Array(n).fill(EMPTY);
    const clues = [];
    for (;;) {
        const now = countSolutions(adj, { k, preset, cap: 20000, nodeLimit: 4_000_000 });
        if (!now.aborted && now.count <= maxSolutions && clues.length >= minClues) return { clues, solutions: now.count };
        if (clues.length >= maxClues) return null;
        const open = [];
        for (let v = 0; v < n; v++) if (preset[v] === EMPTY && !avoid.includes(v)) open.push(v);
        if (!open.length) return null;
        if (now.count >= 20000 || now.aborted) {
            // far from the target: every candidate would still be capped, so
            // pick a well-connected region at random instead of scoring all
            const weighted = open.flatMap(v => Array(adj[v].length).fill(v));
            const v = weighted[Math.floor(rng() * weighted.length)];
            preset[v] = witness[v];
            clues.push(v);
            continue;
        }
        const scored = [];
        for (const v of open) {
            preset[v] = witness[v];
            const c = countSolutions(adj, { k, preset, cap: 20000, nodeLimit: 4_000_000 });
            preset[v] = EMPTY;
            if (c.aborted) continue;
            scored.push({ v, count: c.count + rng() * 0.5 });
        }
        if (!scored.length) return null;
        scored.sort((a, b) => a.count - b.count);
        const pick = scored[Math.min(scored.length - 1, Math.floor(rng() * Math.min(3, scored.length)))];
        preset[pick.v] = witness[pick.v];
        clues.push(pick.v);
    }
}

/**
 * Prefilled (changeable) colors that are conflict-free yet cannot be extended,
 * and whose cheapest repair repaints between minFix and maxFix regions.
 * `visible` asks for a dead end that plain single-candidate reasoning exposes.
 */
export function makeTrap(adj, fixed, witness, { rng, ratio = 0.45, minFix = 2, maxFix = 4, visible = true, tries = 400, k = 4 }) {
    const n = adj.length;
    const free = [];
    for (let v = 0; v < n; v++) if (fixed[v] === EMPTY) free.push(v);
    for (let t = 0; t < tries; t++) {
        // a connected cluster of prefilled regions
        const size = Math.max(3, Math.round(free.length * ratio));
        const start = free[Math.floor(rng() * free.length)];
        const cluster = [start];
        const inC = new Set(cluster);
        while (cluster.length < size) {
            const frontier = [];
            for (const v of cluster) for (const u of adj[v]) if (!inC.has(u) && fixed[u] === EMPTY) frontier.push(u);
            if (!frontier.length) break;
            const u = frontier[Math.floor(rng() * frontier.length)];
            inC.add(u);
            cluster.push(u);
        }
        const colors = fixed.slice();
        for (const v of cluster) colors[v] = witness[v];
        // perturb a few regions while staying conflict-free
        const flips = 1 + Math.floor(rng() * 3);
        for (let f = 0; f < flips; f++) {
            const v = cluster[Math.floor(rng() * cluster.length)];
            const options = candidates(adj, colors, v, k).filter(c => c !== colors[v]);
            if (options.length) colors[v] = options[Math.floor(rng() * options.length)];
        }
        if (hasConflict(adj, colors)) continue;
        const ext = isExtendable(adj, colors, { k, nodeLimit: 2_000_000 });
        if (!ext.known || ext.extendable) continue;
        const near = nearestSolution(adj, colors, { k, fixed, nodeLimit: 1_500_000 });
        if (!near.optimal || near.cost < minFix || near.cost > maxFix) continue;
        if (visible && !propagateSingles(adj, colors, k).contradiction) continue;
        const initial = colors.map((c, v) => (fixed[v] !== EMPTY ? EMPTY : c));
        return { initial, repairCost: near.cost, repair: near.solution };
    }
    return null;
}

/**
 * A nearly finished page: every region painted except `holes`, each of which
 * is surrounded by all four colors. Reachable by `swaps` swaps (exact, BFS),
 * with at least one swapped component of `minComp` regions, while individual
 * repainting needs at least `minRepaint` changes.
 */
export function makeKempeBlock(adj, fixed, { rng, holes = 1, swaps = 1, minComp = 3, minRepaint = 2, tries = 600, k = 4 }) {
    const n = adj.length;
    const locked = fixed.map(c => c !== EMPTY);
    for (let t = 0; t < tries; t++) {
        const pool = [];
        for (let v = 0; v < n; v++) if (fixed[v] === EMPTY && adj[v].length >= 4) pool.push(v);
        if (pool.length < holes) return null;
        const hs = [];
        while (hs.length < holes) {
            const v = pool[Math.floor(rng() * pool.length)];
            if (!hs.includes(v) && !hs.some(h => adj[h].includes(v))) hs.push(v);
            if (hs.length < holes && pool.every(p => hs.includes(p) || hs.some(h => adj[h].includes(p)))) break;
        }
        if (hs.length < holes) continue;
        // color the rest so that every hole sees all four colors
        const sub = adj.map((list, v) => (hs.includes(v) ? [] : list.filter(u => !hs.includes(u))));
        const preset = fixed.slice();
        const col = randomColoring(sub, rng, { k, preset });
        if (!col) continue;
        const colors = col.map((c, v) => (hs.includes(v) ? EMPTY : c));
        const blocked = hs.every(h => candidates(adj, colors, h, k).length === 0);
        if (!blocked) continue;
        const goal = s => hs.every(h => candidates(adj, s, h, k).length > 0)
            && isExtendable(adj, s, { k, nodeLimit: 200_000 }).extendable;
        const bfs = shortestSwapPath(adj, colors, { locked, isGoal: goal, maxStates: 40_000, maxDepth: swaps });
        if (!bfs.found || bfs.distance !== swaps) continue;
        if (!bfs.path.some(m => m.size >= minComp)) continue;
        const near = nearestSolution(adj, colors, { k, fixed, nodeLimit: 1_000_000 });
        if (!near.optimal || near.cost < minRepaint) continue;
        const initial = colors.map((c, v) => (fixed[v] !== EMPTY ? EMPTY : c));
        return { initial, holes: hs, swapPath: bfs.path, repaint: near.cost };
    }
    return null;
}

/**
 * Swap-only challenge built backwards: from a known goal coloring, legal
 * reversible swaps scramble the page; BFS then proves reachability and the
 * minimum number of swaps.
 */
export function makeSwapPuzzle(adj, { rng, anchors = 1, targets = 1, minSteps = 2, maxSteps = 3, needTwoPairs = false, tries = 300, maxStates = 60_000 }) {
    const n = adj.length;
    for (let t = 0; t < tries; t++) {
        const goalColors = randomColoring(adj, rng);
        if (!goalColors) continue;
        const order = [...Array(n).keys()].sort(() => rng() - 0.5);
        const anchorSet = order.slice(0, anchors);
        const targetSet = order.slice(anchors, anchors + targets);
        const locked = new Uint8Array(n);
        for (const a of anchorSet) locked[a] = 1;
        let state = goalColors.slice();
        const scramble = minSteps + Math.floor(rng() * (maxSteps - minSteps + 2));
        for (let s = 0; s < scramble; s++) {
            const moves = legalSwaps(adj, state, locked);
            if (!moves.length) break;
            state = moves[Math.floor(rng() * moves.length)].next;
        }
        const targetList = targetSet.map(v => [v, goalColors[v]]);
        const isGoal = s => targetList.every(([v, c]) => s[v] === c);
        if (isGoal(state)) continue;
        const bfs = shortestSwapPath(adj, state, { locked, isGoal, maxStates });
        if (!bfs.found || !bfs.exhausted) continue;
        if (bfs.distance < minSteps || bfs.distance > maxSteps) continue;
        if (minSteps >= 2 && !bfs.path.some(m => m.size >= 2)) continue;
        if (needTwoPairs) {
            // no single color pair on its own can reach the goal
            let singlePair = false;
            for (const [a, b] of [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]]) {
                const lockedPair = locked;
                const only = shortestSwapPathPair(adj, state, lockedPair, isGoal, a, b, maxStates);
                if (only === null) { singlePair = true; break; } // unknown -> reject
                if (only) { singlePair = true; break; }
            }
            if (singlePair) continue;
        }
        const fixed = new Array(n).fill(EMPTY);
        for (const a of anchorSet) fixed[a] = goalColors[a];
        return {
            initial: state.map((c, v) => (locked[v] ? EMPTY : c)),
            fixed,
            targets: targetList,
            optimal: bfs.distance,
            path: bfs.path,
            explored: bfs.explored,
            goalColors,
        };
    }
    return null;
}

/** BFS restricted to one color pair. true = reachable, false = proven unreachable, null = budget. */
function shortestSwapPathPair(adj, start, locked, isGoal, a, b, maxStates) {
    const seen = new Set([start.join(',')]);
    let frontier = [start];
    while (frontier.length) {
        const next = [];
        for (const s of frontier) {
            for (const mv of legalSwaps(adj, s, locked)) {
                if (!((mv.a === a && mv.b === b))) continue;
                const key = mv.next.join(',');
                if (seen.has(key)) continue;
                if (isGoal(mv.next)) return true;
                seen.add(key);
                if (seen.size > maxStates) return null;
                next.push(mv.next);
            }
        }
        frontier = next;
    }
    return false;
}
