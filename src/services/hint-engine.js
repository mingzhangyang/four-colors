// Three-layer hints, computed from the current page alone:
//   1. point at a region or border worth looking at,
//   2. state one constraint that is actually true,
//   3. suggest one concrete step.
// "Must be X" is only said after every other candidate was ruled out by an
// exhausted search; otherwise the wording stays "could try". When the painted
// layout cannot be extended, the hint asks the player to look back at their
// own regions instead of blaming the map.

import { EMPTY, COLOR_COUNT, findConflicts, neighbourMask, colorsUsed } from '../model/rules.js';
import { isExtendable, viableCandidates, nearestSolution } from '../model/solver.js';
import { shortestSwapPath, kempeComponent } from '../model/kempe.js';

const BUDGET = 300_000;

// Tagged parameters so the UI can format regions and colors in either language.
const R = i => ({ r: i });
const C = c => ({ c });
const CS = list => ({ cs: list });

function bits(mask, k = COLOR_COUNT) {
    const out = [];
    for (let c = 0; c < k; c++) if (mask & (1 << c)) out.push(c);
    return out;
}

function swapOnly(puzzle) {
    return Array.isArray(puzzle.actions) && puzzle.actions.length === 1 && puzzle.actions[0] === 'swap';
}

function hint(layer, key, params, highlight = {}) {
    return { layer, key, params, regions: highlight.regions || [], pairs: highlight.pairs || [], suggestion: highlight.suggestion || null };
}

function swapHint(puzzle, colors, layer) {
    const targets = (puzzle.goals && puzzle.goals.targets) || [];
    const open = targets.filter(([i, c]) => colors[i] !== c);
    if (!open.length) return hint(layer, 'hint.swapDone', {});
    const locked = puzzle.fixed.map(c => c !== EMPTY);
    const isGoal = s => targets.every(([i, c]) => s[i] === c);
    const bfs = shortestSwapPath(puzzle.adj, colors, { locked, isGoal, maxStates: 60_000 });
    const [t, tc] = open[0];
    if (layer === 1) return hint(1, 'hint.swapLook', { region: R(t) }, { regions: [t] });
    if (layer === 2) {
        const comp = kempeComponent(puzzle.adj, colors, t, colors[t], tc);
        const lockedIn = comp.filter(i => locked[i]);
        return hint(2, lockedIn.length ? 'hint.swapLocked' : 'hint.swapFree', { region: R(t), a: C(colors[t]), b: C(tc) },
            { regions: comp });
    }
    if (!bfs.found) return hint(layer, 'hint.unavailable', {});
    const mv = bfs.path[0];
    const comp = kempeComponent(puzzle.adj, colors, mv.region, mv.a, mv.b);
    return hint(3, 'hint.swapMove', { a: C(mv.a), b: C(mv.b), region: R(mv.region) }, { regions: comp, suggestion: { type: 'swap', a: mv.a, b: mv.b, region: mv.region } });
}

export function computeHint(puzzle, colors, layer = 1) {
    layer = Math.max(1, Math.min(3, layer));
    if (swapOnly(puzzle)) return swapHint(puzzle, colors, layer);
    const k = (puzzle.goals && puzzle.goals.maxColors) || COLOR_COUNT;
    const adj = puzzle.adj;
    const n = adj.length;

    // 1) matching neighbours first
    const conflicts = findConflicts(adj, colors);
    if (conflicts.length) {
        const [a, b] = conflicts[0];
        if (layer === 1) return hint(1, 'hint.lookConflict', {}, { pairs: [[a, b]] });
        if (layer === 2) return hint(2, 'hint.conflictRule', { a: R(a), b: R(b) }, { regions: [a, b], pairs: [[a, b]] });
        const soft = colors.slice();
        const near = nearestSolution(adj, soft, { k, fixed: puzzle.fixed, nodeLimit: BUDGET });
        if (!near.solution) return hint(3, 'hint.unavailable', {});
        const pick = [a, b].find(i => puzzle.fixed[i] === EMPTY && near.solution[i] !== colors[i])
            ?? [a, b].find(i => puzzle.fixed[i] === EMPTY);
        return hint(3, 'hint.fixConflict', { region: R(pick), color: C(near.solution[pick]) },
            { regions: [pick], suggestion: { type: 'fill', region: pick, color: near.solution[pick] } });
    }

    // 2) too many colors on a fewer-colors page
    const used = colorsUsed(colors);
    if (used.count > k) {
        const near = nearestSolution(adj, colors, { k, fixed: puzzle.fixed, nodeLimit: BUDGET });
        const changed = near.solution ? colors.map((c, i) => (c !== EMPTY && c !== near.solution[i] ? i : -1)).filter(i => i >= 0) : [];
        if (layer < 3 || !near.solution || !changed.length) return hint(Math.min(layer, 2), 'hint.tooMany', { max: k }, { regions: changed });
        const r = changed[0];
        return hint(3, 'hint.recolor', { region: R(r), color: C(near.solution[r]) }, { regions: [r], suggestion: { type: 'fill', region: r, color: near.solution[r] } });
    }

    const ext = isExtendable(adj, colors, { k, nodeLimit: BUDGET });
    if (!ext.known) return hint(layer, 'hint.unavailable', {});

    if (ext.extendable) {
        const viable = viableCandidates(adj, colors, { k, nodeLimit: BUDGET });
        if (!viable) return hint(layer, 'hint.unavailable', {});
        let best = -1;
        let bestCount = 99;
        let bestSeen = -1;
        for (let v = 0; v < n; v++) {
            if (colors[v] !== EMPTY) continue;
            const count = bits(viable[v], k).length;
            const seen = bits(neighbourMask(adj, colors, v), k).length;
            if (count < bestCount || (count === bestCount && seen > bestSeen)) {
                best = v;
                bestCount = count;
                bestSeen = seen;
            }
        }
        if (best === -1) return hint(layer, 'hint.unavailable', {});
        if (layer === 1) return hint(1, 'hint.lookRegion', { region: R(best), n: bestSeen }, { regions: [best] });
        const options = bits(viable[best], k);
        if (layer === 2) {
            if (options.length === 1) return hint(2, 'hint.mustBe', { region: R(best), color: C(options[0]) }, { regions: [best] });
            const excluded = bits(neighbourMask(adj, colors, best), k);
            if (excluded.length) return hint(2, 'hint.excluded', { region: R(best), colors: CS(excluded) }, { regions: [best] });
            return hint(2, 'hint.canBe', { region: R(best), colors: CS(options) }, { regions: [best] });
        }
        const color = options.length === 1 ? options[0] : ext.solution[best];
        return hint(3, options.length === 1 ? 'hint.paintColor' : 'hint.tryColor', { region: R(best), color: C(color) },
            { regions: [best], suggestion: { type: 'fill', region: best, color } });
    }

    // 3) painted layout cannot be extended: look back, not "the map is unsolvable"
    const near = nearestSolution(adj, colors, { k, fixed: puzzle.fixed, nodeLimit: BUDGET });
    if (!near.solution) return hint(layer, 'hint.unavailable', {});
    const changed = [];
    for (let v = 0; v < n; v++) if (colors[v] !== EMPTY && near.solution[v] !== colors[v]) changed.push(v);
    let blocked = -1;
    for (let v = 0; v < n; v++) {
        if (colors[v] === EMPTY && bits(neighbourMask(adj, colors, v), k).length >= k) { blocked = v; break; }
    }
    if (layer === 1) return hint(1, 'hint.lookBack', {}, { regions: blocked >= 0 ? [blocked, ...changed] : changed });
    if (layer === 2) {
        if (blocked >= 0) return hint(2, 'hint.blocked', { region: R(blocked) }, { regions: [blocked, ...adj[blocked]] });
        return hint(2, 'hint.deadEnd', { n: changed.length }, { regions: changed });
    }
    // optional swap shortcut: one swap that frees the blocked region
    if (blocked >= 0 && Array.isArray(puzzle.actions) && puzzle.actions.includes('swap')) {
        const locked = puzzle.fixed.map(c => c !== EMPTY);
        const goal = s => bits(neighbourMask(adj, s, blocked), k).length < k && isExtendable(adj, s, { k, nodeLimit: 50_000 }).extendable;
        const bfs = shortestSwapPath(adj, colors, { locked, isGoal: goal, maxStates: 4000, maxDepth: 1 });
        if (bfs.found && bfs.path.length === 1) {
            const mv = bfs.path[0];
            return hint(3, 'hint.trySwap', { a: C(mv.a), b: C(mv.b), region: R(mv.region) },
                { regions: kempeComponent(adj, colors, mv.region, mv.a, mv.b), suggestion: { type: 'swap', a: mv.a, b: mv.b, region: mv.region } });
        }
    }
    const r = changed[0];
    if (r === undefined) return hint(3, 'hint.unavailable', {});
    return hint(3, 'hint.recolor', { region: R(r), color: C(near.solution[r]) }, { regions: [r], suggestion: { type: 'fill', region: r, color: near.solution[r] } });
}
