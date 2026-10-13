// The single command entry for a puzzle session. Fill, erase, group swap,
// restart, undo and redo all go through `execute`, which returns a brand-new
// state object; callers then update completion, render and save — in that order.
// Animation never feeds back into this state.

import { EMPTY, COLOR_COUNT, isColor } from './rules.js';
import { previewSwap } from './kempe.js';

export const MAX_HISTORY = 200;
export const TOOLS = ['paint', 'erase', 'swap'];

export function initialColors(puzzle) {
    const n = puzzle.adj.length;
    const colors = puzzle.initial ? puzzle.initial.slice() : new Array(n).fill(EMPTY);
    for (let i = 0; i < n; i++) if (puzzle.fixed[i] !== EMPTY) colors[i] = puzzle.fixed[i];
    return colors;
}

export function createState(puzzle) {
    return {
        puzzleId: puzzle.id,
        revision: puzzle.revision,
        colors: initialColors(puzzle),
        undo: [],
        redo: [],
        stateRevision: 0,
        hintsUsed: 0,
        droppedSwaps: 0,
        truncated: false,
        tool: 'paint',
        color: EMPTY,
        pair: null,
    };
}

function allows(puzzle, action) {
    return !puzzle.actions || puzzle.actions.includes(action);
}

function reject(state, reason) {
    return { ok: false, reason, state, changes: [] };
}

function applyChanges(colors, changes, field) {
    const next = colors.slice();
    for (const ch of changes) next[ch[0]] = ch[field];
    return next;
}

// Swaps that fall off the start of the history still count towards the page's
// swap total, unless a restart fell off after them.
function countDropped(droppedSwaps, entries) {
    for (const e of entries) {
        if (e && e.k === 'swap') droppedSwaps++;
        if (e && e.k === 'restart') droppedSwaps = 0;
    }
    return droppedSwaps;
}

function pushHistory(state, entry) {
    const undo = state.undo.concat([entry]);
    let { droppedSwaps, truncated } = state;
    if (undo.length > MAX_HISTORY) {
        droppedSwaps = countDropped(droppedSwaps, undo.splice(0, undo.length - MAX_HISTORY));
        truncated = true;
    }
    return { undo, droppedSwaps, truncated };
}

function commit(state, entry, colors) {
    const h = pushHistory(state, entry);
    return {
        ...state,
        colors,
        undo: h.undo,
        redo: [],
        droppedSwaps: h.droppedSwaps,
        truncated: h.truncated,
        stateRevision: state.stateRevision + 1,
    };
}

/** Number of swaps on the current history path since the last restart. */
export function swapCount(state) {
    let count = 0;
    for (let i = state.undo.length - 1; i >= 0; i--) {
        const k = state.undo[i].k;
        if (k === 'restart') return count;
        if (k === 'swap') count++;
    }
    return count + state.droppedSwaps;
}

export function execute(puzzle, state, cmd) {
    const n = puzzle.adj.length;
    switch (cmd.type) {
    case 'select': {
        const next = { ...state };
        if (cmd.tool !== undefined) {
            if (!TOOLS.includes(cmd.tool)) return reject(state, 'bad-tool');
            if (cmd.tool === 'swap' && !allows(puzzle, 'swap')) return reject(state, 'not-allowed');
            if (cmd.tool === 'erase' && !allows(puzzle, 'erase')) return reject(state, 'not-allowed');
            next.tool = cmd.tool;
        }
        if (cmd.color !== undefined) {
            if (cmd.color !== EMPTY && !isColor(cmd.color)) return reject(state, 'bad-color');
            next.color = cmd.color;
        }
        if (cmd.pair !== undefined) {
            if (cmd.pair !== null && !(Array.isArray(cmd.pair) && cmd.pair.length <= 2 && cmd.pair.every(isColor))) {
                return reject(state, 'bad-color');
            }
            next.pair = cmd.pair;
        }
        return { ok: true, state: next, changes: [] };
    }
    case 'fill': {
        if (!allows(puzzle, 'fill')) return reject(state, 'not-allowed');
        const { region, color } = cmd;
        if (!Number.isInteger(region) || region < 0 || region >= n) return reject(state, 'bad-region');
        if (!isColor(color)) return reject(state, 'no-color');
        if (puzzle.fixed[region] !== EMPTY) return reject(state, 'fixed');
        const before = state.colors[region];
        if (before === color) return reject(state, 'noop');
        const changes = [[region, before, color]];
        return { ok: true, state: commit(state, { k: 'fill', c: changes }, applyChanges(state.colors, changes, 2)), changes };
    }
    case 'erase': {
        if (!allows(puzzle, 'erase')) return reject(state, 'not-allowed');
        const { region } = cmd;
        if (!Number.isInteger(region) || region < 0 || region >= n) return reject(state, 'bad-region');
        if (puzzle.fixed[region] !== EMPTY) return reject(state, 'fixed');
        const before = state.colors[region];
        if (before === EMPTY) return reject(state, 'noop');
        const changes = [[region, before, EMPTY]];
        return { ok: true, state: commit(state, { k: 'erase', c: changes }, applyChanges(state.colors, changes, 2)), changes };
    }
    case 'swap': {
        if (!allows(puzzle, 'swap')) return reject(state, 'not-allowed');
        const { region, a, b } = cmd;
        if (!Number.isInteger(region) || region < 0 || region >= n) return reject(state, 'bad-region');
        const preview = previewSwap(puzzle, state.colors, region, a, b);
        if (!preview.ok) return { ...reject(state, preview.reason), preview };
        const changes = preview.changes;
        return {
            ok: true,
            state: commit(state, { k: 'swap', c: changes, p: [a, b] }, applyChanges(state.colors, changes, 2)),
            changes,
            preview,
        };
    }
    case 'restart': {
        const target = initialColors(puzzle);
        const changes = [];
        for (let i = 0; i < n; i++) if (state.colors[i] !== target[i]) changes.push([i, state.colors[i], target[i]]);
        if (!changes.length) return reject(state, 'noop');
        return { ok: true, state: commit(state, { k: 'restart', c: changes }, target), changes };
    }
    case 'undo': {
        if (!state.undo.length) return reject(state, 'empty-history');
        const entry = state.undo[state.undo.length - 1];
        const colors = applyChanges(state.colors, entry.c, 1);
        return {
            ok: true,
            state: {
                ...state,
                colors,
                undo: state.undo.slice(0, -1),
                redo: state.redo.concat([entry]),
                stateRevision: state.stateRevision + 1,
            },
            changes: entry.c.map(([i, b, a]) => [i, a, b]),
            entry,
        };
    }
    case 'redo': {
        if (!state.redo.length) return reject(state, 'empty-history');
        const entry = state.redo[state.redo.length - 1];
        const colors = applyChanges(state.colors, entry.c, 2);
        const h = pushHistory(state, entry);
        return {
            ok: true,
            state: {
                ...state,
                colors,
                undo: h.undo,
                droppedSwaps: h.droppedSwaps,
                truncated: h.truncated,
                redo: state.redo.slice(0, -1),
                stateRevision: state.stateRevision + 1,
            },
            changes: entry.c,
            entry,
        };
    }
    case 'hint-used':
        return { ok: true, state: { ...state, hintsUsed: state.hintsUsed + 1 }, changes: [] };
    default:
        return reject(state, 'unknown-command');
    }
}

/**
 * Validate a restored state against the puzzle. Anything malformed is dropped:
 * returns a clean state or null when the colors themselves cannot be trusted.
 */
export function restoreState(puzzle, raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.puzzleId !== puzzle.id || raw.revision !== puzzle.revision) return null;
    const n = puzzle.adj.length;
    if (!Array.isArray(raw.colors) || raw.colors.length !== n) return null;
    const colorOk = c => c === EMPTY || (Number.isInteger(c) && c >= 0 && c < COLOR_COUNT);
    if (!raw.colors.every(colorOk)) return null;
    for (let i = 0; i < n; i++) {
        if (puzzle.fixed[i] !== EMPTY && raw.colors[i] !== puzzle.fixed[i]) return null;
    }
    const entryOk = e => e && typeof e === 'object' && ['fill', 'erase', 'swap', 'restart'].includes(e.k)
        && Array.isArray(e.c) && e.c.every(ch => Array.isArray(ch) && ch.length === 3
            && Number.isInteger(ch[0]) && ch[0] >= 0 && ch[0] < n && colorOk(ch[1]) && colorOk(ch[2])
            && puzzle.fixed[ch[0]] === EMPTY);
    const base = createState(puzzle);
    let undo = Array.isArray(raw.undo) && raw.undo.every(entryOk) ? raw.undo.slice(-MAX_HISTORY) : null;
    let redo = Array.isArray(raw.redo) && raw.redo.every(entryOk) ? raw.redo.slice(-MAX_HISTORY) : null;
    // History must replay back onto the restored colors; otherwise drop it.
    if (undo) {
        let probe = raw.colors.slice();
        for (let i = undo.length - 1; i >= 0 && undo; i--) {
            for (const [r, , after] of undo[i].c) if (probe[r] !== after) { undo = null; break; }
            if (undo) probe = applyChanges(probe, undo[i].c, 1);
        }
    }
    if (redo) {
        let probe = raw.colors.slice();
        for (let i = redo.length - 1; i >= 0 && redo; i--) {
            for (const [r, before] of redo[i].c) if (probe[r] !== before) { redo = null; break; }
            if (redo) probe = applyChanges(probe, redo[i].c, 2);
        }
    }
    const tool = TOOLS.includes(raw.tool) && (raw.tool !== 'swap' || allows(puzzle, 'swap'))
        && (raw.tool !== 'erase' || allows(puzzle, 'erase')) ? raw.tool : 'paint';
    return {
        ...base,
        colors: raw.colors.slice(),
        undo: undo || [],
        redo: redo || [],
        truncated: Boolean(raw.truncated) || (!undo && Array.isArray(raw.undo) && raw.undo.length > 0),
        droppedSwaps: Number.isInteger(raw.droppedSwaps) && raw.droppedSwaps >= 0 ? raw.droppedSwaps : 0,
        stateRevision: Number.isInteger(raw.stateRevision) && raw.stateRevision >= 0 ? raw.stateRevision : 0,
        hintsUsed: Number.isInteger(raw.hintsUsed) && raw.hintsUsed >= 0 ? raw.hintsUsed : 0,
        tool,
        color: colorOk(raw.color) ? raw.color : EMPTY,
        pair: Array.isArray(raw.pair) && raw.pair.length <= 2 && raw.pair.every(c => Number.isInteger(c) && c >= 0 && c < COLOR_COUNT)
            ? raw.pair.slice() : null,
    };
}

/** Compact a state for storage: cap history and drop transient fields. */
export function serializeState(state, maxHistory = MAX_HISTORY) {
    const undo = state.undo.slice(-maxHistory);
    const droppedSwaps = countDropped(state.droppedSwaps, state.undo.slice(0, state.undo.length - undo.length));
    return {
        puzzleId: state.puzzleId,
        revision: state.revision,
        colors: state.colors.slice(),
        undo,
        redo: state.redo.slice(-maxHistory),
        truncated: state.truncated || undo.length < state.undo.length,
        droppedSwaps,
        stateRevision: state.stateRevision,
        hintsUsed: state.hintsUsed,
        tool: state.tool,
        color: state.color,
        pair: state.pair,
    };
}

/** Trim a stored session to its last `max` undo/redo entries, keeping its swap total. */
export function trimSavedHistory(saved, max) {
    if (!Array.isArray(saved.undo) || saved.undo.length <= max) return saved;
    const cut = saved.undo.length - max;
    const dropped = Number.isInteger(saved.droppedSwaps) && saved.droppedSwaps >= 0 ? saved.droppedSwaps : 0;
    return {
        ...saved,
        undo: saved.undo.slice(cut),
        redo: Array.isArray(saved.redo) ? saved.redo.slice(-max) : [],
        droppedSwaps: countDropped(dropped, saved.undo.slice(0, cut)),
        truncated: true,
    };
}
