// Model tests: geometry-derived adjacency, rules, commands, undo/redo, the
// two-color swap, solver claims (cross-checked by brute force), hints,
// storage, settings precedence and the async hint service.

import assert from 'node:assert/strict';
import { test, run } from './lib/harness.mjs';
import { buildMesh } from '../tools/lib/mesh-build.mjs';
import { compileMesh } from '../tools/lib/mesh-compiler.mjs';
import { grid2x2, k4Disc, hexRing, bands } from '../tools/levels/shapes.mjs';
import { EMPTY, evaluate, findConflicts, isValidSolution } from '../src/model/rules.js';
import { createState, execute, restoreState, serializeState, swapCount, MAX_HISTORY } from '../src/model/commands.js';
import { kempeComponent, previewSwap, shortestSwapPath } from '../src/model/kempe.js';
import { solve, countSolutions, isExtendable, nearestSolution, chromaticNumber, viableCandidates } from '../src/model/solver.js';
import { computeHint } from '../src/services/hint-engine.js';
import { createHintService } from '../src/services/hints.js';
import { createStorage, createSaveManager, validateSnapshot, emptySnapshot, storageKey } from '../src/storage.js';
import { resolveEntry, sanitizeSettings } from '../src/services/settings.js';

// ── independent helpers (never the solver under test) ──
function bruteForceColorings(adj, k, preset = null) {
    const n = adj.length;
    const colors = new Array(n).fill(-1);
    let count = 0;
    let first = null;
    (function rec(i) {
        if (i === n) {
            count++;
            if (!first) first = colors.slice();
            return;
        }
        const options = preset && preset[i] >= 0 ? [preset[i]] : [...Array(k).keys()];
        for (const c of options) {
            if (adj[i].some(j => j < i && colors[j] === c)) continue;
            colors[i] = c;
            rec(i + 1);
            colors[i] = -1;
        }
    })(0);
    return { count, first };
}

function compile(shape, opts = {}) {
    const mesh = buildMesh(shape.cells, { regionCount: shape.cells.length });
    return compileMesh(mesh, { regionIds: shape.regionIds, ...opts });
}

function puzzle(adj, extra = {}) {
    return { id: 'T1', revision: 1, adj, fixed: adj.map(() => EMPTY), initial: null, actions: ['fill', 'erase', 'swap'], goals: {}, ...extra };
}

const PATH4 = [[1], [0, 2], [1, 3], [2]];
const K4 = [[1, 2, 3], [0, 2, 3], [0, 1, 3], [0, 1, 2]];

// ── geometry ──
test('corner-only contact is not adjacency (2×2 grid is a 4-cycle)', () => {
    const c = compile(grid2x2(), { allowCornerContacts: true });
    assert.deepEqual(c.errors, []);
    // A B / D C : A–B, B–C, C–D, D–A ; A–C and B–D only meet at the centre
    assert.deepEqual(c.adj, [[1, 3], [0, 2], [1, 3], [0, 2]]);
    assert.equal(c.cornerContacts.length, 2);
    const strict = compile(grid2x2());
    assert.ok(strict.errors.some(e => /corner/.test(e)), 'corner contacts must be reported when not allowed');
});

test('K4 disc compiles to the complete graph on four regions', () => {
    const c = compile(k4Disc());
    assert.deepEqual(c.errors, []);
    assert.deepEqual(c.adj, K4);
});

test('hex ring: centre touches all six ring plots, ring is a 6-cycle', () => {
    const c = compile(hexRing());
    assert.deepEqual(c.errors, []);
    assert.deepEqual(c.adj[0], [1, 2, 3, 4, 5, 6]);
    for (let r = 1; r <= 6; r++) {
        const prev = r === 1 ? 6 : r - 1;
        const next = r === 6 ? 1 : r + 1;
        assert.ok(c.adj[r].includes(prev) && c.adj[r].includes(next) && c.adj[r].includes(0));
    }
    assert.equal(c.cornerContacts.length, 0);
});

test('bands form a path A—B—C—D', () => {
    const c = compile(bands(4));
    assert.deepEqual(c.adj, PATH4);
});

test('compiler rejects zero-length and non-manifold edges and cracks', () => {
    const c = compile(bands(2));
    const mesh = buildMesh(bands(2).cells, { regionCount: 2 });
    // zero-length: an edge with a repeated point
    const bad = structuredClone(mesh);
    bad.edges[0].v = [bad.edges[0].v[0], bad.edges[0].v[0]];
    assert.ok(compileMesh(bad).errors.length > 0);
    // non-manifold: the same edge used twice forward
    const nm = structuredClone(mesh);
    nm.rings[0] = nm.rings[0].concat([nm.rings[0][0]]);
    assert.ok(compileMesh(nm).errors.some(e => /non-manifold|open|times/.test(e)));
    // crack: two rectangles 0.3 apart never become neighbours and are flagged
    const crack = buildMesh([
        { ring: [[0, 0], [100, 0], [100, 100], [0, 100]], region: 0 },
        { ring: [[100.3, 0], [200, 0], [200, 100], [100.3, 100]], region: 1 },
    ], { regionCount: 2 });
    const cc = compileMesh(crack);
    assert.ok(cc.errors.some(e => /crack|nearly touch/.test(e)), cc.errors.join('\n'));
    assert.equal(c.errors.length, 0);
});

test('compiler enforces minimum shared border and inscribed radius', () => {
    const c = compile(k4Disc(), { minInradius: 500 });
    assert.ok(c.errors.some(e => /inscribed radius/.test(e)));
    const s = compile(bands(4), { minShared: 10000 });
    assert.ok(s.errors.some(e => /share only/.test(e)));
});

// ── rules ──
test('unpainted regions never conflict; incomplete pages never complete', () => {
    const p = puzzle(PATH4);
    const ev = evaluate(p, [0, EMPTY, 0, EMPTY]);
    assert.equal(ev.conflictCount, 0);
    assert.equal(ev.complete, false);
    assert.equal(ev.empty, 2);
});

test('conflicts are reported per neighbouring pair', () => {
    assert.deepEqual(findConflicts(PATH4, [1, 1, 1, 2]), [[0, 1], [1, 2]]);
});

test('completion follows the rules, not a reference coloring (multiple solutions)', () => {
    const p = puzzle(PATH4);
    assert.ok(isValidSolution(p, [0, 1, 0, 1]));
    assert.ok(isValidSolution(p, [2, 3, 1, 0]));
    assert.ok(!isValidSolution(p, [0, 0, 1, 2]));
});

test('fixed stamps cannot change and must hold for completion', () => {
    const p = puzzle(PATH4, { fixed: [2, EMPTY, EMPTY, EMPTY] });
    let s = createState(p);
    assert.equal(s.colors[0], 2);
    const r = execute(p, s, { type: 'fill', region: 0, color: 1 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'fixed');
    assert.equal(execute(p, s, { type: 'erase', region: 0 }).reason, 'fixed');
    s = execute(p, s, { type: 'fill', region: 1, color: 0 }).state;
    s = execute(p, s, { type: 'restart' }).state;
    assert.deepEqual(s.colors, [2, EMPTY, EMPTY, EMPTY]);
});

test('targets and max-colors goals', () => {
    const p = puzzle(PATH4, { goals: { targets: [[2, 0]], maxColors: 2 } });
    assert.equal(evaluate(p, [0, 1, 2, 1]).complete, false); // target unmet + 3 colors
    assert.equal(evaluate(p, [1, 2, 0, 1]).complete, false); // 3 colors
    assert.equal(evaluate(p, [0, 1, 0, 1]).complete, true);
});

// ── commands ──
test('undo / redo, and redo is invalidated by a new command', () => {
    const p = puzzle(PATH4);
    let s = createState(p);
    s = execute(p, s, { type: 'fill', region: 0, color: 1 }).state;
    s = execute(p, s, { type: 'fill', region: 1, color: 2 }).state;
    s = execute(p, s, { type: 'undo' }).state;
    assert.deepEqual(s.colors, [1, EMPTY, EMPTY, EMPTY]);
    assert.equal(s.redo.length, 1);
    s = execute(p, s, { type: 'redo' }).state;
    assert.deepEqual(s.colors, [1, 2, EMPTY, EMPTY]);
    s = execute(p, s, { type: 'undo' }).state;
    s = execute(p, s, { type: 'fill', region: 3, color: 0 }).state;
    assert.equal(s.redo.length, 0);
    assert.equal(execute(p, s, { type: 'redo' }).ok, false);
    const rev = s.stateRevision;
    s = execute(p, s, { type: 'select', color: 3 }).state;
    assert.equal(s.stateRevision, rev, 'selection does not change the state revision');
});

test('restart is a single undoable command', () => {
    const p = puzzle(PATH4, { initial: [0, EMPTY, EMPTY, EMPTY] });
    let s = createState(p);
    s = execute(p, s, { type: 'fill', region: 1, color: 1 }).state;
    s = execute(p, s, { type: 'fill', region: 2, color: 2 }).state;
    s = execute(p, s, { type: 'restart' }).state;
    assert.deepEqual(s.colors, [0, EMPTY, EMPTY, EMPTY]);
    s = execute(p, s, { type: 'undo' }).state;
    assert.deepEqual(s.colors, [0, 1, 2, EMPTY]);
});

test('history beyond the cap keeps recent commands and reports truncation', () => {
    const p = puzzle(PATH4);
    let s = createState(p);
    for (let i = 0; i < MAX_HISTORY + 25; i++) s = execute(p, s, { type: 'fill', region: i % 4, color: (i % 3) + (i % 4 === 3 ? 0 : 1) }).state;
    assert.equal(s.undo.length, MAX_HISTORY);
    assert.equal(s.truncated, true);
});

// ── swap ──
test('swap takes the complete two-color component and never truncates at a lock', () => {
    // path A-B-C-D colored 0,1,0,1 : the 0/1 component is everything
    const p = puzzle(PATH4);
    assert.deepEqual(kempeComponent(PATH4, [0, 1, 0, 1], 0, 0, 1), [0, 1, 2, 3]);
    const locked = puzzle(PATH4, { fixed: [EMPTY, EMPTY, EMPTY, 1] });
    const pv = previewSwap(locked, [0, 1, 0, 1], 0, 0, 1);
    assert.equal(pv.ok, false);
    assert.equal(pv.reason, 'locked');
    assert.deepEqual(pv.regions, [0, 1, 2, 3]);
    assert.deepEqual(pv.locked, [3]);
    let s = { ...createState(locked), colors: [0, 1, 0, 1] };
    assert.equal(execute(locked, s, { type: 'swap', region: 0, a: 0, b: 1 }).ok, false);
    s = { ...createState(p), colors: [0, 1, 0, 1] };
    const r = execute(p, s, { type: 'swap', region: 0, a: 0, b: 1 });
    assert.ok(r.ok);
    assert.deepEqual(r.state.colors, [1, 0, 1, 0]);
});

test('FC26 sample: the 0/2 component of C is C alone, never the disconnected A', () => {
    const colors = [0, 1, 2, 1];
    assert.deepEqual(kempeComponent(PATH4, colors, 2, 0, 2), [2]);
    const p = puzzle(PATH4, { actions: ['swap'], goals: { targets: [[2, 0]] } });
    const s = { ...createState(p), colors };
    const r = execute(p, s, { type: 'swap', region: 2, a: 0, b: 2 });
    assert.deepEqual(r.state.colors, [0, 1, 0, 1]);
    assert.equal(evaluate(p, r.state.colors).complete, true);
    // one undo restores the whole component
    assert.deepEqual(execute(p, r.state, { type: 'undo' }).state.colors, colors);
    assert.equal(swapCount(r.state), 1);
});

test('unpainted regions are not part of a component; conflicts block swapping', () => {
    assert.deepEqual(kempeComponent(PATH4, [0, EMPTY, 0, 1], 0, 0, 1), [0]);
    const p = puzzle(PATH4);
    const pv = previewSwap(p, [0, 0, 1, EMPTY], 2, 1, 2);
    assert.equal(pv.reason, 'conflicts');
});

test('swap undo restores a multi-region component in one step', () => {
    const p = puzzle(K4.map(l => l.slice()));
    let s = { ...createState(p), colors: [0, 1, 2, 3] };
    s = execute(p, s, { type: 'swap', region: 0, a: 0, b: 1 }).state;
    assert.deepEqual(s.colors, [1, 0, 2, 3]);
    s = execute(p, s, { type: 'undo' }).state;
    assert.deepEqual(s.colors, [0, 1, 2, 3]);
});

test('swap BFS finds the minimum and reports exhaustion', () => {
    const r = shortestSwapPath(PATH4, [0, 1, 2, 1], { locked: [false, false, false, false], isGoal: s => s[2] === 0 });
    assert.equal(r.found, true);
    assert.equal(r.distance, 1);
    const none = shortestSwapPath([[1], [0]], [0, 1], { locked: [true, true], isGoal: s => s[0] === 1 });
    assert.equal(none.found, false);
    assert.equal(none.exhausted, true);
});

// ── solver claims vs brute force ──
test('K4 needs four colors: solver and brute force agree', () => {
    assert.equal(bruteForceColorings(K4, 3).count, 0);
    assert.ok(bruteForceColorings(K4, 4).count > 0);
    const three = solve(K4, { k: 3, limit: 1 });
    assert.equal(three.count, 0);
    assert.equal(three.exhausted, true);
    assert.equal(chromaticNumber(K4).k, 4);
});

test('C4 is two-colorable; solution counts match brute force', () => {
    const C4 = [[1, 3], [0, 2], [1, 3], [0, 2]];
    assert.equal(chromaticNumber(C4).k, 2);
    for (const k of [2, 3, 4]) {
        assert.equal(countSolutions(C4, { k, cap: 1e6 }).count, bruteForceColorings(C4, k).count);
    }
    const wheel = hexRingAdj();
    assert.equal(countSolutions(wheel, { k: 4, cap: 1e7 }).count, bruteForceColorings(wheel, 4).count);
    // up to color permutation
    assert.equal(countSolutions(C4, { k: 2, symmetry: true, cap: 100 }).count, 1);
});

function hexRingAdj() {
    return compile(hexRing()).adj;
}

test('FC16 ring: 0,1,2,3,0,1 blocks the centre; 0,1,0,1,0,1 frees colour 2', () => {
    const adj = hexRingAdj();
    const blocked = new Array(11).fill(EMPTY);
    [0, 1, 2, 3, 0, 1].forEach((c, i) => { blocked[i + 1] = c; });
    assert.equal(findConflicts(adj, blocked).length, 0);
    assert.equal(bruteForceColorings(adj, 4, blocked).count, 0, 'no completion keeps the blocking ring');
    assert.equal(isExtendable(adj, blocked).extendable, false);
    const freed = new Array(11).fill(EMPTY);
    [0, 1, 0, 1, 0, 1].forEach((c, i) => { freed[i + 1] = c; });
    freed[0] = 2;
    assert.ok(bruteForceColorings(adj, 4, freed).count > 0);
});

test('nearest solution repaints the fewest player regions', () => {
    const adj = hexRingAdj();
    const colors = new Array(11).fill(EMPTY);
    [0, 1, 2, 3, 0, 1].forEach((c, i) => { colors[i + 1] = c; });
    const r = nearestSolution(adj, colors, { fixed: new Array(11).fill(EMPTY) });
    assert.ok(r.optimal);
    assert.equal(r.cost, 1, 'one ring plot can change to free the centre');
});

// ── hints ──
test('hint "must be" is only claimed when every other color is ruled out', () => {
    const p = puzzle(K4, { actions: ['fill', 'erase'] });
    const colors = [0, 1, 2, EMPTY];
    const h2 = computeHint(p, colors, 2);
    assert.equal(h2.key, 'hint.mustBe');
    assert.deepEqual(h2.params.color, { c: 3 });
    // independent: only color 3 completes
    for (let c = 0; c < 3; c++) assert.equal(bruteForceColorings(K4, 4, [0, 1, 2, c]).count, 0);
    // with real freedom the wording stays "could try"
    const free = computeHint(puzzle(PATH4), [EMPTY, EMPTY, EMPTY, EMPTY], 3);
    assert.equal(free.key, 'hint.tryColor');
    const viable = viableCandidates(PATH4, [EMPTY, EMPTY, EMPTY, EMPTY]);
    assert.equal(viable[0], 15);
});

test('hints point at conflicts first and look back when the layout is a dead end', () => {
    const p = puzzle(PATH4);
    const c1 = computeHint(p, [0, 0, EMPTY, EMPTY], 1);
    assert.equal(c1.key, 'hint.lookConflict');
    assert.deepEqual(c1.pairs, [[0, 1]]);
    const adj = hexRingAdj();
    const ring = puzzle(adj);
    const colors = new Array(11).fill(EMPTY);
    [0, 1, 2, 3, 0, 1].forEach((c, i) => { colors[i + 1] = c; });
    assert.equal(computeHint(ring, colors, 1).key, 'hint.lookBack');
    const h2 = computeHint(ring, colors, 2);
    assert.equal(h2.key, 'hint.blocked');
    assert.deepEqual(h2.params.region, { r: 0 });
    const h3 = computeHint(ring, colors, 3);
    assert.ok(['hint.recolor', 'hint.trySwap'].includes(h3.key));
});

test('swap-only hints suggest a legal minimal swap', () => {
    const p = puzzle(PATH4, { actions: ['swap'], goals: { targets: [[2, 0]] } });
    const h = computeHint(p, [0, 1, 2, 1], 3);
    assert.equal(h.key, 'hint.swapMove');
    assert.deepEqual(h.suggestion, { type: 'swap', a: 0, b: 2, region: 2 });
});

// ── restore / storage ──
test('restored state is validated: revision, colors, fixed, history', () => {
    const p = puzzle(PATH4, { fixed: [1, EMPTY, EMPTY, EMPTY] });
    let s = createState(p);
    s = execute(p, s, { type: 'fill', region: 1, color: 2 }).state;
    const saved = serializeState(s);
    const back = restoreState(p, JSON.parse(JSON.stringify(saved)));
    assert.deepEqual(back.colors, s.colors);
    assert.equal(back.undo.length, 1);
    assert.equal(restoreState({ ...p, revision: 2 }, saved), null, 'other revision is not reused');
    assert.equal(restoreState(p, { ...saved, colors: [1, 9, EMPTY, EMPTY] }), null);
    assert.equal(restoreState(p, { ...saved, colors: [0, EMPTY, EMPTY, EMPTY] }), null, 'fixed must match');
    assert.equal(restoreState(p, { ...saved, colors: [1, 2, EMPTY] }), null);
    const brokenHistory = restoreState(p, { ...saved, undo: [{ k: 'fill', c: [[1, EMPTY, 3]] }] });
    assert.deepEqual(brokenHistory.undo, [], 'history that does not replay is dropped');
    assert.deepEqual(brokenHistory.colors, s.colors);
});

function memoryBackend({ failWrites = false } = {}) {
    const map = new Map();
    return {
        map,
        getItem: k => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => { if (failWrites) throw new Error('QuotaExceededError'); map.set(k, String(v)); },
        removeItem: k => map.delete(k),
    };
}

test('storage trySet reports failure; save never claims success on failure', () => {
    const storage = createStorage({ backend: memoryBackend({ failWrites: true }) });
    assert.equal(storage.trySet('x', { a: 1 }), false);
    const saves = createSaveManager({ storage, tabId: 'a' });
    const snap = saves.load();
    assert.deepEqual(saves.save(snap), { ok: false, reason: 'write-failed' });
});

test('snapshot validation drops corrupted parts', () => {
    const raw = {
        ...emptySnapshot(),
        current: { kind: 'main', id: 'FC01', revision: 1 },
        sessions: { 'FC01@1': { colors: [0, 1, -1] }, 'bad key': { colors: [0] }, 'FC02@1': { colors: [7] } },
        progress: { FC01: { revision: 1, completed: true, independent: 'yes', solution: [0, 1] }, '../x': { revision: 1 } },
        daily: { session: { date: '2026-10-12', id: 'D001', revision: 1 }, records: { nope: {} } },
        collection: [{ uid: 'a', id: 'FC01', revision: 1, colors: [0, 1] }, { uid: 3 }],
    };
    const v = validateSnapshot(raw);
    assert.deepEqual(Object.keys(v.sessions), ['FC01@1']);
    assert.equal(v.progress.FC01.completed, true);
    assert.equal(v.progress.FC01.independent, false);
    assert.equal(Object.keys(v.progress).length, 1);
    assert.deepEqual(v.daily.records, {});
    assert.equal(v.collection.length, 1);
    assert.equal(validateSnapshot('garbage').schema, 1);
    assert.equal(validateSnapshot({ schema: 99 }).current, null);
});

test('multi-tab: a newer write from another tab is never silently overwritten', () => {
    const backend = memoryBackend();
    const storage = createStorage({ backend });
    const a = createSaveManager({ storage, tabId: 'A' });
    const b = createSaveManager({ storage, tabId: 'B' });
    const sa = a.load();
    const sb = b.load();
    assert.equal(a.save({ ...sa, lastTab: 'ch1' }).ok, true);
    assert.equal(b.hasConflict(), true);
    assert.deepEqual(b.save(sb), { ok: false, reason: 'conflict' });
    assert.equal(b.save(sb, { force: true }).ok, true);
    assert.equal(JSON.parse(backend.getItem(storageKey('save'))).writer, 'B');
    const reloaded = b.load();
    assert.equal(reloaded.writer, 'B');
});

// ── settings ──
test('entry settings: stored preference > URL parameter > browser', () => {
    const r1 = resolveEntry({ stored: { lang: 'zh' }, search: '?lang=en&theme=dark&p=FC08', browserLang: 'en-US', systemDark: false });
    assert.equal(r1.lang, 'zh');
    assert.equal(r1.theme, 'dark');
    assert.equal(r1.cleanSearch, '?p=FC08', 'only recognised parameters are removed');
    const r2 = resolveEntry({ stored: {}, search: '?lang=en', browserLang: 'zh-CN', systemDark: true });
    assert.equal(r2.lang, 'en');
    assert.equal(r2.theme, 'dark');
    const r3 = resolveEntry({ stored: {}, search: '?lang=fr&theme=neon', browserLang: 'zh-TW', systemDark: false });
    assert.equal(r3.lang, 'zh');
    assert.equal(r3.theme, 'light');
    assert.equal(r3.cleanSearch, '');
    assert.equal(sanitizeSettings({ muted: 'no' }).muted, true, 'sound defaults to muted');
});

// ── async hint service ──
test('hint service: tagged replies, timeout and cancellation never touch state', async () => {
    const silent = () => ({ postMessage() {}, onmessage: null, onerror: null });
    const svc = createHintService({ timeoutMs: 40, workerFactory: silent });
    const r = await svc.request({ sessionId: 1, puzzleRevision: 1, stateRevision: 5, puzzle: puzzle(PATH4), colors: [0, -1, -1, -1], layer: 1 });
    assert.equal(r.timedOut, true);
    assert.equal(r.result, null);
    assert.equal(r.stateRevision, 5);
    let worker;
    const echo = () => (worker = { postMessage(msg) { setTimeout(() => worker.onmessage({ data: { ...msg, result: { key: 'x' } } }), 5); } });
    const svc2 = createHintService({ timeoutMs: 500, workerFactory: echo });
    const r2 = await svc2.request({ sessionId: 3, puzzleRevision: 2, stateRevision: 9, puzzle: puzzle(PATH4), colors: [0, -1, -1, -1], layer: 1 });
    assert.equal(r2.sessionId, 3);
    assert.equal(r2.stateRevision, 9);
    const pending = svc.request({ sessionId: 1, puzzleRevision: 1, stateRevision: 6, puzzle: puzzle(PATH4), colors: [0, -1, -1, -1], layer: 1 });
    svc.cancelAll();
    assert.equal((await pending).cancelled, true);
    // no Worker at all: computed asynchronously with the same tags
    const svc3 = createHintService({ timeoutMs: 500, workerFactory: () => { throw new Error('no worker'); } });
    const r3 = await svc3.request({ sessionId: 4, puzzleRevision: 1, stateRevision: 1, puzzle: puzzle(PATH4), colors: [0, 0, -1, -1], layer: 1 });
    assert.equal(r3.result.key, 'hint.lookConflict');
});

await run('verify-four-colors-rules');
