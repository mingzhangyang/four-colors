// Two-color swap ("双色交换"): the Kempe-chain move. A swap takes the complete
// connected component containing `start` inside the subgraph induced by colors
// a and b, and exchanges a <-> b on every region of it. Unpainted regions are
// never part of a component. A component that holds a fixed stamp cannot be
// swapped at all — it is never truncated in front of the lock.

import { EMPTY, COLOR_COUNT, hasConflict } from './rules.js';

export const COLOR_PAIRS = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];

/** BFS for the full a/b component of `start`. Returns sorted region indices. */
export function kempeComponent(adj, colors, start, a, b) {
    const c0 = colors[start];
    if (a === b || (c0 !== a && c0 !== b)) return [];
    const seen = new Uint8Array(adj.length);
    const queue = [start];
    seen[start] = 1;
    for (let head = 0; head < queue.length; head++) {
        const v = queue[head];
        for (const u of adj[v]) {
            if (seen[u]) continue;
            const c = colors[u];
            if (c === a || c === b) {
                seen[u] = 1;
                queue.push(u);
            }
        }
    }
    return queue.sort((x, y) => x - y);
}

/**
 * Everything the UI needs to preview a swap before it is confirmed.
 * reason: null | 'same-colors' | 'not-in-pair' | 'conflicts' | 'locked'
 */
export function previewSwap(puzzle, colors, start, a, b) {
    if (a === b || a < 0 || b < 0 || a >= COLOR_COUNT || b >= COLOR_COUNT) {
        return { ok: false, reason: 'same-colors', regions: [], locked: [] };
    }
    if (colors[start] !== a && colors[start] !== b) {
        return { ok: false, reason: 'not-in-pair', regions: [], locked: [] };
    }
    if (hasConflict(puzzle.adj, colors)) {
        return { ok: false, reason: 'conflicts', regions: [], locked: [] };
    }
    const regions = kempeComponent(puzzle.adj, colors, start, a, b);
    const locked = regions.filter(i => puzzle.fixed[i] !== EMPTY);
    return {
        ok: locked.length === 0,
        reason: locked.length ? 'locked' : null,
        regions,
        locked,
        changes: regions.map(i => [i, colors[i], colors[i] === a ? b : a]),
    };
}

export function swapColors(colors, regions, a, b) {
    const next = colors.slice();
    for (const i of regions) next[i] = colors[i] === a ? b : a;
    return next;
}

// ---- state-space search (used by the generator, verifiers and swap hints) ----

/** Encode a color vector (EMPTY allowed) as an exact integer key (base 5, n ≤ 22). */
export function encodeColors(colors) {
    let key = 0;
    for (let i = colors.length - 1; i >= 0; i--) key = key * 5 + (colors[i] + 1);
    return key;
}

/** All distinct legal swaps from a state. */
export function legalSwaps(adj, colors, lockedMask) {
    const moves = [];
    const seenStates = new Set();
    for (const [a, b] of COLOR_PAIRS) {
        const done = new Uint8Array(adj.length);
        for (let v = 0; v < adj.length; v++) {
            if (done[v] || (colors[v] !== a && colors[v] !== b)) continue;
            const comp = kempeComponent(adj, colors, v, a, b);
            for (const u of comp) done[u] = 1;
            if (comp.some(u => lockedMask[u])) continue;
            const next = swapColors(colors, comp, a, b);
            const key = encodeColors(next);
            if (seenStates.has(key)) continue;
            seenStates.add(key);
            moves.push({ a, b, region: comp[0], regions: comp, next, key });
        }
    }
    return moves;
}

/**
 * Breadth-first search over swap moves. `isGoal(colors)` decides success.
 * Only an exhausted search may be reported as "unreachable".
 */
export function shortestSwapPath(adj, start, { locked, isGoal, maxStates = 200_000, maxDepth = Infinity }) {
    const lockedMask = locked instanceof Uint8Array ? locked : Uint8Array.from(locked.map(Boolean));
    const startKey = encodeColors(start);
    if (isGoal(start)) return { found: true, distance: 0, path: [], exhausted: true, explored: 1 };
    const parent = new Map([[startKey, null]]);
    let frontier = [{ colors: start, key: startKey }];
    let depth = 0;
    while (frontier.length && depth < maxDepth) {
        depth++;
        const next = [];
        for (const node of frontier) {
            for (const mv of legalSwaps(adj, node.colors, lockedMask)) {
                if (parent.has(mv.key)) continue;
                parent.set(mv.key, { prev: node.key, move: { a: mv.a, b: mv.b, region: mv.region, size: mv.regions.length } });
                if (isGoal(mv.next)) {
                    const path = [];
                    let k = mv.key;
                    while (parent.get(k)) {
                        const p = parent.get(k);
                        path.unshift(p.move);
                        k = p.prev;
                    }
                    return { found: true, distance: depth, path, exhausted: true, explored: parent.size };
                }
                if (parent.size >= maxStates) {
                    return { found: false, distance: null, path: null, exhausted: false, explored: parent.size };
                }
                next.push({ colors: mv.next, key: mv.key });
            }
        }
        frontier = next;
    }
    return {
        found: false,
        distance: null,
        path: null,
        exhausted: frontier.length === 0,
        explored: parent.size,
    };
}
