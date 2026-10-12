// Pure rule layer: no DOM, no storage. Colors are logical indices 0–3; EMPTY (-1)
// means the region has not been painted yet. Adjacency only comes from shared
// non-zero-length boundaries (see tools/lib/mesh-compiler.mjs); corner contacts
// never appear in `adj`.

export const COLOR_COUNT = 4;
export const EMPTY = -1;

export function isColor(value) {
    return Number.isInteger(value) && value >= 0 && value < COLOR_COUNT;
}

/** Every adjacent pair (i < j) that currently shares the same color. */
export function findConflicts(adj, colors) {
    const out = [];
    for (let i = 0; i < adj.length; i++) {
        const c = colors[i];
        if (c === EMPTY) continue;
        for (const j of adj[i]) {
            if (j > i && colors[j] === c) out.push([i, j]);
        }
    }
    return out;
}

export function hasConflict(adj, colors) {
    for (let i = 0; i < adj.length; i++) {
        const c = colors[i];
        if (c === EMPTY) continue;
        for (const j of adj[i]) if (j > i && colors[j] === c) return true;
    }
    return false;
}

export function colorsUsed(colors) {
    let mask = 0;
    for (const c of colors) if (c !== EMPTY) mask |= 1 << c;
    let count = 0;
    for (let c = 0; c < COLOR_COUNT; c++) if (mask & (1 << c)) count++;
    return { mask, count };
}

/** Colors already taken by painted neighbours of region i. */
export function neighbourMask(adj, colors, i) {
    let mask = 0;
    for (const j of adj[i]) if (colors[j] !== EMPTY) mask |= 1 << colors[j];
    return mask;
}

export function targetsOf(puzzle) {
    return (puzzle.goals && puzzle.goals.targets) || [];
}

/**
 * Completion judgement. It never compares against a reference coloring:
 * a level is complete when every region is painted, no adjacent pair shares a
 * color, every fixed stamp still holds and the level's extra goals are met.
 */
export function evaluate(puzzle, colors) {
    const n = puzzle.adj.length;
    let filled = 0;
    for (let i = 0; i < n; i++) if (colors[i] !== EMPTY) filled++;
    const conflicts = findConflicts(puzzle.adj, colors);
    let fixedOk = true;
    for (let i = 0; i < n; i++) {
        if (puzzle.fixed[i] !== EMPTY && colors[i] !== puzzle.fixed[i]) fixedOk = false;
    }
    const targets = targetsOf(puzzle);
    let targetsMet = 0;
    for (const [i, c] of targets) if (colors[i] === c) targetsMet++;
    const used = colorsUsed(colors);
    const maxColors = puzzle.goals && puzzle.goals.maxColors;
    const maxColorsOk = !maxColors || used.count <= maxColors;
    const complete = filled === n && conflicts.length === 0 && fixedOk
        && targetsMet === targets.length && maxColorsOk;
    return {
        total: n,
        filled,
        empty: n - filled,
        conflicts,
        conflictCount: conflicts.length,
        fixedOk,
        targetsMet,
        targetsTotal: targets.length,
        colorsUsed: used.count,
        maxColors: maxColors || COLOR_COUNT,
        maxColorsOk,
        complete,
    };
}

/** A plain validity check used by verifiers: complete, proper, matches fixed + goals. */
export function isValidSolution(puzzle, colors) {
    if (!Array.isArray(colors) || colors.length !== puzzle.adj.length) return false;
    if (!colors.every(isColor)) return false;
    return evaluate(puzzle, colors).complete;
}
