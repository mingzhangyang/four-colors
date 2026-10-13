#!/usr/bin/env node
// Offline content pipeline for 四色图志.
//
//   specs (tools/levels/*.mjs)
//     → pages (seeded Voronoi / hand-built polygons) → shared mesh → hand-drawn wobble
//     → compiler checks (tools/lib/mesh-compiler.mjs)
//     → puzzle construction + certificates (tools/lib/puzzle.mjs, src/model/*)
//     → level master data   content/master/*.json        (mesh, clues, witness, certs)
//     → runtime modules      src/content/generated/*.js    (paths, adjacency, checksum)
//     → daily bank           public/daily/*.json + src/content/generated/daily-manifest.js (numbered No.1…N)
//
// `--check` regenerates everything in memory and fails if any committed file
// differs, if a level's topology changed without a revision bump, or if a dated
// daily entry would be rewritten.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MAIN, STORIES, CHAPTER_ART } from '../levels/main.mjs';
import { dailySpecs, DAILY_EPOCH } from '../levels/daily.mjs';
import { grid2x2, k4Disc, hexRing, bands, warpFn, combineMeshes, PAGE } from '../levels/shapes.mjs';
import { voronoiPage, chordPage } from '../lib/mapgen.mjs';
import { buildMesh, MeshError } from '../lib/mesh-build.mjs';
import { wobbleMesh, transformMesh } from '../lib/wobble.mjs';
import { compileMesh } from '../lib/mesh-compiler.mjs';
import { mulberry32, hashSeed } from '../lib/geometry.mjs';
import {
    randomColoring, chooseClues, measure, makeTrap, makeKempeBlock, makeSwapPuzzle,
} from '../lib/puzzle.mjs';
import { solve, countSolutions, chromaticNumber, isExtendable } from '../../src/model/solver.js';
import { shortestSwapPath, kempeComponent } from '../../src/model/kempe.js';
import { EMPTY, evaluate, hasConflict, neighbourMask } from '../../src/model/rules.js';
import { levelChecksum, fnv1a } from '../../src/content/checksum.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHECK = process.argv.includes('--check');
const ONLY = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const VERBOSE = process.argv.includes('--verbose');

const MAX_ATTEMPTS = 400;
const MIN_INRADIUS = 24;
const MIN_SHARED = 18;

const outputs = new Map(); // relative path -> content
const problems = [];

function log(...args) {
    if (!CHECK || VERBOSE) console.log(...args);
}

// ───────────────────────────── pages ─────────────────────────────

function readingIds(compiled, count) {
    const order = compiled.regions
        .map((r, i) => ({ i, x: r.pole.x, y: r.pole.y }))
        .sort((a, b) => Math.floor(a.y / 90) - Math.floor(b.y / 90) || a.x - b.x);
    const ids = new Array(count);
    order.forEach(({ i }, rank) => { ids[i] = String.fromCharCode(65 + rank); });
    return ids;
}

function makePage(spec, attempt) {
    const g = spec.gen;
    const rng = mulberry32(hashSeed('wobble', spec.id, attempt));
    const wob = g.wobble || {};
    const scale = attempt >= 3 ? 0.5 : 1;
    const wobbleOpts = { amp: (wob.amp ?? 3) * scale, coastAmp: (wob.coastAmp ?? 4) * scale, step: 9 };
    let cells;
    let regionIds = null;
    let regionCount;
    switch (g.type) {
    case 'voronoi': {
        const frame = g.twin ? [20, 20, 460, 306] : PAGE;
        const page = voronoiPage({ ...g, frame, attempt });
        cells = page.cells;
        regionCount = page.regionCount;
        break;
    }
    case 'chords': {
        const page = chordPage({ seed: g.seed, attempt, lines: g.lines });
        if (page.regionCount < g.minRegions || page.regionCount > g.maxRegions) throw new MeshError('chord count');
        cells = page.cells;
        regionCount = page.regionCount;
        break;
    }
    case 'grid2x2': ({ cells, regionIds } = grid2x2()); break;
    case 'k4': ({ cells, regionIds } = k4Disc()); break;
    case 'hexring': ({ cells, regionIds } = hexRing()); break;
    case 'bands': ({ cells, regionIds } = bands(g.count)); break;
    default: throw new Error(`unknown page type ${g.type}`);
    }
    regionCount = regionCount ?? regionIds.length;
    let mesh = buildMesh(cells, { regionCount });
    mesh = wobbleMesh(mesh, rng, wobbleOpts);
    const views = [];
    if (g.twin) {
        const warp = warpFn({ frame: [20, 20, 460, 306], rotate: true, ax: 34, ay: 26, fx: 1.4, fy: 1.2, phase: 0.4 + (attempt % 5) * 0.3 });
        const lower = transformMesh(mesh, p => { const [x, y] = warp(p); return [x, y + 314]; });
        mesh = combineMeshes(mesh, lower);
        regionCount *= 2;
    }
    if (g.views === 'mirror-warp') {
        const warp = warpFn({ frame: PAGE, mirror: true, ax: 38, ay: 34, fx: 1.2, fy: 0.9, phase: 1.1 + (attempt % 5) * 0.25 });
        views.push(transformMesh(mesh, warp));
    }
    return { mesh, views, regionIds, regionCount, water: Boolean(g.water) };
}

function compilePage(spec, page) {
    const isMain = spec.mode !== 'daily';
    const opts = {
        minInradius: spec.minInradius ?? (spec.gen.twin ? 20 : MIN_INRADIUS),
        minShared: spec.minShared ?? MIN_SHARED,
        allowCornerContacts: Boolean(spec.allowCornerContacts),
        regionIds: page.regionIds,
    };
    const c = compileMesh(page.mesh, opts);
    if (c.errors.length) return { errors: c.errors };
    const views = [];
    for (const v of page.views) {
        const cv = compileMesh(v, opts);
        if (cv.errors.length) return { errors: cv.errors.map(e => `view: ${e}`) };
        if (JSON.stringify(cv.adj) !== JSON.stringify(c.adj)) return { errors: ['view changes adjacency'] };
        views.push(cv);
    }
    // structure: no isolated plots, at most one leaf, optional hub
    const deg = c.adj.map(l => l.length);
    if (deg.some(d => d === 0)) return { errors: ['isolated region'] };
    if (isMain && !spec.allowLeaves && !spec.gen.twin && deg.filter(d => d === 1).length > 1) return { errors: ['too many leaf regions'] };
    if (spec.gen.twin && deg.filter(d => d === 1).length > 2) return { errors: ['too many leaf regions'] };
    if (spec.gen.hub && Math.max(...deg) < 6) return { errors: ['no hub region'] };
    if (c.adj.length !== page.regionCount) return { errors: ['region count mismatch'] };
    return { compiled: c, views };
}

// ───────────────────────────── puzzles ─────────────────────────────

function difficultyTag(m, n) {
    const score = m.trapRate * 10 + n / 6 - (m.singlesFilled / n) * 2;
    if (score < 2.5) return 'gentle';
    if (score < 5) return 'moderate';
    if (score < 7.5) return 'tricky';
    return 'hard';
}

function buildPuzzle(spec, compiled, rng) {
    const adj = compiled.adj;
    const n = adj.length;
    const p = spec.puzzle;
    const none = () => new Array(n).fill(EMPTY);
    const k = p.k || 4;
    const cert = { regions: n, playtested: false };
    let fixed = none();
    let initial = null;
    const goals = {};
    let witness;
    const chroma = chromaticNumber(adj);
    if (!chroma.exact) return null;
    cert.chromatic = chroma.k;

    switch (p.type) {
    case 'free': {
        if (p.maxChromatic && chroma.k > p.maxChromatic) return null;
        if (p.exactChromatic && chroma.k !== p.exactChromatic) return null;
        witness = randomColoring(adj, rng);
        if (chroma.k < 4) {
            // prove fewer colors suffice (witness) and fewer than that does not
            cert.fewerColors = { k: chroma.k, witness: chroma.witness };
        }
        if (chroma.k === 4) {
            const three = solve(adj, { k: 3, limit: 1 });
            cert.threeColorInfeasible = three.count === 0 && three.exhausted;
            if (!cert.threeColorInfeasible) return null;
        }
        break;
    }
    case 'clues':
    case 'trap':
    case 'max-colors': {
        if (chroma.k > k) return null;
        if (p.type === 'max-colors' && chroma.k !== k) return null;
        witness = randomColoring(adj, rng, { k });
        const pick = chooseClues(adj, witness, { rng, k, maxSolutions: p.maxSolutions, maxClues: p.maxClues, minClues: p.minClues });
        if (!pick) return null;
        for (const v of pick.clues) fixed[v] = witness[v];
        if (p.type === 'max-colors') {
            goals.maxColors = k;
            cert.fewerColors = { k, witness };
        }
        if (p.type === 'trap') {
            const trap = makeTrap(adj, fixed, witness, { rng, ratio: p.ratio, minFix: p.minFix, maxFix: p.maxFix, visible: true, tries: 250 });
            if (!trap) return null;
            initial = trap.initial;
            witness = trap.repair;
            cert.trap = { repairCost: trap.repairCost, extendable: false };
        }
        break;
    }
    case 'twin-clues': {
        const m = n / 2;
        const top = adj.slice(0, m).map(l => l.filter(u => u < m));
        const wTop = randomColoring(top, rng);
        const pick = chooseClues(top, wTop, { rng, maxSolutions: p.maxSolutions, maxClues: p.maxClues, minClues: p.minClues });
        if (!pick) return null;
        // the lower map repeats the structure; its clues use a permuted palette
        const perm = [2, 3, 0, 1];
        witness = wTop.concat(wTop.map(c => perm[c]));
        for (const v of pick.clues) {
            fixed[v] = wTop[v];
            fixed[v + m] = perm[wTop[v]];
        }
        for (let v = 0; v < m; v++) {
            const lower = adj[v + m].map(u => u - m).sort((a, b) => a - b);
            if (JSON.stringify(lower) !== JSON.stringify(top[v])) return null;
        }
        cert.twin = { half: m, permutation: perm };
        break;
    }
    case 'ring-block': {
        // X = 0, R1–R6 = 1..6, corners 7..10 (see shapes.hexRing)
        initial = none();
        [0, 1, 2, 3, 0, 1].forEach((c, i) => { initial[1 + i] = c; });
        if (hasConflict(adj, initial)) return null;
        if (neighbourMask(adj, initial, 0) !== 15) return null;
        const ext = isExtendable(adj, initial);
        if (!ext.known || ext.extendable) return null;
        const preset = none();
        [0, 1, 0, 1, 0, 1].forEach((c, i) => { preset[1 + i] = c; });
        preset[0] = 2;
        witness = solve(adj, { preset, limit: 1 }).solutions[0];
        if (!witness) return null;
        cert.ringBlock = { ringBefore: [0, 1, 2, 3, 0, 1], ringAfter: [0, 1, 0, 1, 0, 1], centre: 2 };
        break;
    }
    case 'fc26': {
        initial = [0, 1, 2, 1];
        goals.targets = [[2, 0]];
        witness = [0, 1, 0, 1];
        const bfs = shortestSwapPath(adj, initial, { locked: new Array(n).fill(false), isGoal: s => s[2] === 0, maxStates: 1000 });
        if (!bfs.found || bfs.distance !== 1) return null;
        if (JSON.stringify(kempeComponent(adj, initial, 2, 0, 2)) !== '[2]') return null;
        goals.optimalSwaps = 1;
        cert.swap = { optimal: 1, explored: bfs.explored, exhausted: true, path: bfs.path };
        break;
    }
    case 'kempe-block': {
        const w0 = randomColoring(adj, rng);
        const order = [...Array(n).keys()].filter(v => adj[v].length >= 3).sort(() => rng() - 0.5);
        for (const v of order.slice(0, p.clues || 0)) fixed[v] = w0[v];
        const block = makeKempeBlock(adj, fixed, { rng, holes: p.holes, swaps: p.swaps, minComp: p.minComp, minRepaint: p.minRepaint, tries: 300 });
        if (!block) return null;
        initial = block.initial;
        const full = initial.map((c, v) => (fixed[v] !== EMPTY ? fixed[v] : c));
        // witness: apply the swap path, then paint the holes
        const s = full.slice();
        for (const mv of block.swapPath) {
            const comp = kempeComponent(adj, s, mv.region, mv.a, mv.b);
            for (const u of comp) s[u] = s[u] === mv.a ? mv.b : mv.a;
        }
        const ext = isExtendable(adj, s);
        if (!ext.extendable) return null;
        witness = ext.solution;
        cert.kempe = { holes: block.holes, swaps: block.swapPath.map(m => ({ a: m.a, b: m.b, size: m.size })), repaintWithoutSwap: block.repaint };
        break;
    }
    case 'swap': {
        const sp = makeSwapPuzzle(adj, { rng, anchors: p.anchors, targets: p.targets, minSteps: p.minSteps, maxSteps: p.maxSteps, needTwoPairs: p.needTwoPairs, tries: 120 });
        if (!sp) return null;
        fixed = sp.fixed;
        initial = sp.initial;
        goals.targets = sp.targets;
        goals.optimalSwaps = sp.optimal;
        witness = sp.goalColors;
        // a full-page swap of one pair must not finish the level on its own
        cert.swap = { optimal: sp.optimal, explored: sp.explored, exhausted: true, path: sp.path, needTwoPairs: Boolean(p.needTwoPairs) };
        break;
    }
    default:
        throw new Error(`unknown puzzle type ${p.type}`);
    }

    const puzzle = { adj, fixed, initial, goals, actions: spec.actions || ['fill', 'erase'] };
    if (!witness || !evaluate(puzzle, witness).complete) return null;
    if (spec.actions && spec.actions.length === 1 && spec.actions[0] === 'swap') {
        // swap-only: the starting page must already be a proper complete coloring
        const start = initial.map((c, v) => (fixed[v] !== EMPTY ? fixed[v] : c));
        if (start.some(c => c === EMPTY) || hasConflict(adj, start)) return null;
    }
    const preset = initial ? initial.map((c, v) => (fixed[v] !== EMPTY ? fixed[v] : EMPTY)) : fixed;
    const m = measure(adj, preset, rng, k);
    const sol = countSolutions(adj, { k, preset: fixed, cap: 5000, nodeLimit: 3_000_000 });
    cert.solutions = { count: sol.count, exact: sol.exact, colors: k };
    cert.unique = sol.exact && sol.count === 1;
    cert.difficulty = m;
    const tags = [difficultyTag(m, n), `regions:${n}`];
    const clueCount = fixed.filter(c => c !== EMPTY).length;
    if (clueCount) tags.push(`clues:${clueCount}`);
    if (initial && p.type !== 'swap' && p.type !== 'fc26') tags.push('prefilled');
    if ((spec.actions || []).includes('swap')) tags.push('swap');
    if (goals.maxColors) tags.push(`max-colors:${goals.maxColors}`);
    if (chroma.k === 4) tags.push('needs-four');
    return { fixed, initial, goals, witness, cert, tags };
}

// ───────────────────────────── art anchors ─────────────────────────────

function artAnchors(spec, compiled, puzzle, rng) {
    const kinds = CHAPTER_ART[spec.chapter] || CHAPTER_ART[1];
    const blocked = new Set();
    puzzle.fixed.forEach((c, i) => { if (c !== EMPTY) blocked.add(i); });
    for (const [i] of puzzle.goals.targets || []) blocked.add(i);
    const ranked = compiled.regions
        .filter(r => !blocked.has(r.index) && r.pole.d >= 30)
        .sort((a, b) => b.pole.d - a.pole.d);
    const count = Math.min(ranked.length, Math.max(2, Math.min(4, Math.round(compiled.regions.length / 4))));
    const out = [];
    for (let k = 0; k < count; k++) {
        const r = ranked[k];
        const kind = kinds[Math.floor(rng() * kinds.length)];
        const s = Math.max(0.75, Math.min(2.1, (r.pole.d - 8) / 22));
        out.push([r.index, kind, Math.round(r.pole.x), Math.round(r.pole.y), Math.round(s * 100) / 100]);
    }
    return out;
}

// ───────────────────────────── level assembly ─────────────────────────────

function viewData(c) {
    const [x0, y0, x1, y1] = c.bbox;
    const pad = 6;
    return {
        box: [Math.floor(x0 - pad), Math.floor(y0 - pad), Math.ceil(x1 - x0 + 2 * pad), Math.ceil(y1 - y0 + 2 * pad)],
        paths: c.regionPaths,
        labels: c.regions.map(r => [Math.round(r.pole.x * 10) / 10, Math.round(r.pole.y * 10) / 10, Math.round(r.pole.d * 10) / 10]),
        shared: c.sharedEdges.map(e => [e.a, e.b, e.d]),
        outline: c.outline,
        coast: c.coast,
    };
}

function flatMesh(mesh) {
    return { vertices: mesh.vertices.flat(), edges: mesh.edges.map(e => [e.a, e.b, e.v]), rings: mesh.rings };
}

function buildLevel(spec, mode, index) {
    spec = { ...spec, mode };
    let lastErrors = [];
    const tally = {};
    const note = list => {
        lastErrors = list;
        const key = list[0].replace(/[0-9.]+/g, '#');
        tally[key] = (tally[key] || 0) + 1;
    };
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        let page;
        try {
            page = makePage(spec, attempt);
        } catch (e) {
            if (e instanceof MeshError || /land|allocate|stalled|chord/.test(e.message)) { note([e.message]); continue; }
            throw e;
        }
        const res = compilePage(spec, page);
        if (res.errors) { note(res.errors); continue; }
        const { compiled, views } = res;
        const rng = mulberry32(hashSeed('puzzle', spec.id, attempt));
        const puzzle = buildPuzzle(spec, compiled, rng);
        if (!puzzle) { note(['puzzle construction failed']); continue; }
        const ids = page.regionIds || readingIds(compiled, compiled.adj.length);
        const art = artAnchors(spec, compiled, puzzle, mulberry32(hashSeed('art', spec.id)));
        const main = viewData(compiled);
        const level = {
            id: spec.id,
            revision: spec.revision,
            mode,
            chapter: spec.chapter,
            index,
            name: spec.name,
            note: spec.note || null,
            water: page.water,
            ids,
            box: main.box,
            paths: main.paths,
            labels: main.labels,
            shared: main.shared,
            outline: main.outline,
            coast: main.coast,
            adj: compiled.adj,
            fixed: puzzle.fixed,
            initial: puzzle.initial,
            actions: spec.actions || ['fill', 'erase'],
            goals: puzzle.goals,
            witness: puzzle.witness,
            tags: puzzle.tags,
            art,
            views: views.map(viewData),
        };
        if (spec.no) level.no = spec.no;
        level.checksum = levelChecksum(level);
        const master = {
            id: spec.id,
            revision: spec.revision,
            mode,
            chapter: spec.chapter,
            seed: spec.gen.seed ?? null,
            attempt,
            mesh: flatMesh(page.mesh),
            views: page.views.map(flatMesh),
            regionIds: ids,
            fixedColors: puzzle.fixed,
            initialColors: puzzle.initial,
            allowedActions: level.actions,
            goals: puzzle.goals,
            witness: puzzle.witness,
            difficultyTags: puzzle.tags,
            artAnchors: art,
            cert: { ...puzzle.cert, cornerContacts: compiled.cornerContacts.length, checksum: level.checksum },
        };
        log(`${spec.id.padEnd(5)} attempt ${String(attempt).padStart(3)}  n=${String(compiled.adj.length).padStart(2)}  χ=${puzzle.cert.chromatic}  `
            + `sol=${puzzle.cert.solutions.count}${puzzle.cert.solutions.exact ? '' : '+'}  trap=${puzzle.cert.difficulty.trapRate}  ${puzzle.tags.join(' ')}`);
        return { level, master };
    }
    throw new Error(`${spec.id}: no valid page after ${MAX_ATTEMPTS} attempts — ${JSON.stringify(tally)}; last: ${lastErrors.slice(0, 2).join('; ')}`);
}

/** Isomorphism-invariant structure signature (Weisfeiler–Lehman over adjacency + clue colors). */
export function structureSignature(level) {
    const n = level.adj.length;
    let labels = level.adj.map((_, i) => `${level.fixed[i]}:${level.initial ? level.initial[i] : -1}`);
    for (let round = 0; round < 4; round++) {
        labels = labels.map((l, i) => fnv1a(`${l}|${level.adj[i].map(j => labels[j]).sort().join(',')}`));
    }
    return fnv1a(`${n}|${labels.slice().sort().join(',')}`);
}

function topologyHash(level) {
    return fnv1a(JSON.stringify([level.adj, level.fixed, level.initial, level.goals, level.actions]));
}

// ───────────────────────────── outputs ─────────────────────────────

function levelReport(mainLevels, stories, daily, masters, dailyMasters) {
    const certOf = id => (masters.find(m => m.id === id) || dailyMasters.find(m => m.id === id)).cert;
    const row = lv => {
        const c = certOf(lv.id);
        const clues = lv.fixed.filter(x => x !== EMPTY).length;
        const pre = lv.initial ? lv.initial.filter(x => x !== EMPTY).length : 0;
        const sol = `${c.solutions.count}${c.solutions.exact ? '' : '+'}${c.solutions.colors < 4 ? ` (${c.solutions.colors} 色)` : ''}`;
        const notes = [];
        if (c.threeColorInfeasible) notes.push('3 色不可解（穷举）');
        if (c.fewerColors) notes.push(`${c.fewerColors.k} 色见证`);
        if (c.ringBlock) notes.push('外环阻塞中心，重排可解');
        if (c.trap) notes.push(`预填无扩展解，最少改 ${c.trap.repairCost} 块`);
        if (c.kempe) notes.push(`${c.kempe.swaps.length} 次交换腾色（分量 ${c.kempe.swaps.map(m => m.size).join('/')}），逐块需改 ${c.kempe.repaintWithoutSwap}`);
        if (c.swap) notes.push(`最少 ${c.swap.optimal} 次交换（BFS 逐层证明，探索 ${c.swap.explored} 状态）${c.swap.needTwoPairs ? '，单一色对不可达' : ''}`);
        if (c.twin) notes.push('两图同构');
        if (lv.views.length) notes.push('两种外形同构');
        if (c.cornerContacts) notes.push(`角点接触 ${c.cornerContacts}`);
        const name = lv.mode === 'daily' ? `No.${lv.no}` : lv.name.zh;
        return `| ${lv.id} | ${name} | ${lv.adj.length} | ${c.chromatic} | ${clues} | ${pre} | ${sol} | ${c.difficulty.trapRate} | ${lv.tags[0]} | ${notes.join('；')} |`;
    };
    const head = '| ID | 名称 | 区域 | χ | 固定 | 预填 | 解数 | 陷阱率 | 难度 | 证书 |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |';
    return [
        '<!-- GENERATED by tools/generators/four-colors-build.mjs — do not edit. -->',
        '# 关卡证书报告',
        '',
        '每关的见证均由独立验证器复核（tests/verify-four-colors-levels.mjs、tests/verify-four-colors-daily.mjs）。',
        '“解数”为满足固定印章的着色数（上限 5000，带 + 表示达到上限）；“陷阱率”为随机顺序玩家模型在 160 次模拟中走入死局的比例，只作难度信号，不代表人类难度；全部关卡尚未经过真人试玩。',
        '',
        '## 主线',
        '',
        head,
        ...mainLevels.map(row),
        '',
        '## 修复短篇',
        '',
        head,
        ...stories.map(row),
        '',
        '## 每日题库',
        '',
        head,
        ...daily.map(row),
        '',
    ].join('\n');
}

function moduleText(comment, value) {
    return `// GENERATED by tools/generators/four-colors-build.mjs — do not edit.\n// ${comment}\n\nexport default ${JSON.stringify(value)};\n`;
}

function emit(rel, content) {
    outputs.set(rel, content);
}

function readJson(rel, fallback) {
    const p = join(ROOT, rel);
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback;
}

function main() {
    const t0 = Date.now();
    const selected = list => (ONLY.length ? list.filter(s => ONLY.includes(s.id)) : list);
    const mainLevels = [];
    const masters = [];
    for (const [i, spec] of MAIN.entries()) {
        if (ONLY.length && !ONLY.includes(spec.id)) continue;
        const { level, master } = buildLevel(spec, 'main', i + 1);
        mainLevels.push(level);
        masters.push(master);
    }
    const stories = [];
    for (const [i, spec] of selected(STORIES).entries()) {
        const { level, master } = buildLevel(spec, 'story', i + 1);
        stories.push(level);
        masters.push(master);
    }
    const daily = [];
    const dailyMasters = [];
    for (const [i, spec] of selected(dailySpecs()).entries()) {
        const { level, master } = buildLevel(spec, 'daily', i + 1);
        daily.push(level);
        dailyMasters.push(master);
    }
    if (ONLY.length) {
        console.log(`--only build finished in ${((Date.now() - t0) / 1000).toFixed(1)}s (nothing written)`);
        return;
    }

    // revision lock: topology changes must bump the revision
    const lock = readJson('tools/levels/revisions.lock.json', {});
    const nextLock = {};
    for (const lv of [...mainLevels, ...stories, ...daily]) {
        const topo = topologyHash(lv);
        const prev = lock[lv.id];
        if (prev && prev.revision === lv.revision && prev.topology !== topo) {
            problems.push(`${lv.id}: topology changed but revision is still ${lv.revision} — bump the revision`);
        }
        if (prev && lv.revision < prev.revision) problems.push(`${lv.id}: revision went backwards`);
        nextLock[lv.id] = { revision: lv.revision, topology: topo };
    }

    // structure dedupe across main, stories and daily
    const seen = new Map();
    for (const lv of [...mainLevels, ...stories, ...daily]) {
        const sig = structureSignature(lv);
        if (seen.has(sig)) problems.push(`${lv.id} duplicates the structure of ${seen.get(sig)}`);
        seen.set(sig, lv.id);
    }

    // daily manifest: numbered puzzles, immutable once released; the epoch is locked too
    const dailyLock = readJson('content/daily-lock.json', { epoch: null, entries: [] });
    const lockedByNo = new Map(dailyLock.entries.map(e => [e.no, e]));
    const manifestEntries = daily.map(lv => ({ no: lv.no, id: lv.id, revision: lv.revision, checksum: lv.checksum }));
    if (dailyLock.epoch && dailyLock.epoch !== DAILY_EPOCH) {
        problems.push(`daily epoch is locked to ${dailyLock.epoch}; changing it to ${DAILY_EPOCH} would shift which number is “today” for every player`);
    }
    manifestEntries.forEach((e, i) => {
        if (e.no !== i + 1) problems.push(`daily numbers must be consecutive from 1 (found No.${e.no} at position ${i + 1})`);
        const old = lockedByNo.get(e.no);
        if (old && (old.id !== e.id || old.revision !== e.revision || old.checksum !== e.checksum)) {
            problems.push(`daily No.${e.no} is locked to ${old.id} r${old.revision} (${old.checksum}); generator now produced ${e.id} r${e.revision} (${e.checksum})`);
        }
    });
    for (const old of dailyLock.entries) {
        if (!manifestEntries.some(e => e.no === old.no)) problems.push(`daily No.${old.no} disappeared from the manifest`);
    }

    // write
    const byChapter = [1, 2, 3, 4].map(ch => mainLevels.filter(l => l.chapter === ch));
    byChapter.forEach((levels, i) => emit(`src/content/generated/chapter-${i + 1}.js`, moduleText(`Chapter ${i + 1} main-line levels (compiled).`, levels)));
    emit('src/content/generated/stories.js', moduleText('Short repair stories (compiled).', stories));
    const index = {
        main: mainLevels.map(l => ({ id: l.id, revision: l.revision, chapter: l.chapter, index: l.index, name: l.name, regions: l.adj.length, tags: l.tags, checksum: l.checksum })),
        stories: stories.map(l => ({ id: l.id, revision: l.revision, chapter: l.chapter, index: l.index, name: l.name, regions: l.adj.length, tags: l.tags, checksum: l.checksum })),
    };
    emit('src/content/generated/index.js', moduleText('Level index: ids, names and checksums.', index));
    emit('src/content/generated/daily-manifest.js', moduleText('Numbered daily puzzles. Today = UTC+8 days since epoch + 1. Immutable once released (content/daily-lock.json).', {
        version: 2,
        epoch: DAILY_EPOCH,
        entries: manifestEntries,
    }));
    for (const lv of daily) emit(`public/daily/${lv.id}.r${lv.revision}.json`, `${JSON.stringify(lv)}\n`);
    emit('docs/level-report.md', levelReport(mainLevels, stories, daily, masters, dailyMasters));
    emit('content/master/levels.json', `${JSON.stringify({ generator: 1, levels: masters })}\n`);
    emit('content/master/daily.json', `${JSON.stringify({ generator: 1, levels: dailyMasters })}\n`);
    emit('content/daily-lock.json', `${JSON.stringify({ note: 'Released daily numbers are immutable and the epoch never moves after launch. Append only.', epoch: DAILY_EPOCH, entries: manifestEntries }, null, 1)}\n`);
    emit('tools/levels/revisions.lock.json', `${JSON.stringify(nextLock, null, 1)}\n`);

    if (problems.length) {
        console.error(problems.map(p => `✗ ${p}`).join('\n'));
        process.exit(1);
    }

    let stale = 0;
    // stale daily files
    const dailyDir = join(ROOT, 'public/daily');
    const expectedDaily = new Set([...outputs.keys()].filter(k => k.startsWith('public/daily/')).map(k => k.slice('public/daily/'.length)));
    if (existsSync(dailyDir)) {
        for (const f of readdirSync(dailyDir)) {
            if (!expectedDaily.has(f)) {
                if (CHECK) { console.error(`✗ stale file public/daily/${f}`); stale++; }
                else rmSync(join(dailyDir, f));
            }
        }
    }
    for (const [rel, content] of outputs) {
        const abs = join(ROOT, rel);
        const current = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
        if (current === content) continue;
        if (CHECK) {
            console.error(`✗ ${rel} is out of date — run npm run content:build`);
            stale++;
        } else {
            mkdirSync(dirname(abs), { recursive: true });
            writeFileSync(abs, content);
            log(`wrote ${relative(ROOT, abs)} (${(content.length / 1024).toFixed(1)} KB)`);
        }
    }
    if (CHECK && stale) process.exit(1);
    console.log(`${CHECK ? 'content check passed' : 'content built'}: ${mainLevels.length} main, ${stories.length} stories, ${daily.length} daily in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main();
