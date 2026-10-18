// Numbered map bank verifier: complete access, immutable content and legacy save compatibility.

import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test, run } from './lib/harness.mjs';
import manifest from '../src/content/generated/daily-manifest.js';
import { levelChecksum } from '../src/content/checksum.js';
import { borderPaths } from '../src/render/scenery.js';
import { numberedEntry, numberedBankPlan, countRestoredMaps } from '../src/services/daily.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(readFileSync(join(ROOT, 'content/daily-lock.json'), 'utf8'));
const dailyFile = e => join(ROOT, 'public/daily', `${e.id}.r${e.revision}.json`);
const DAILY = manifest.entries.map(e => JSON.parse(readFileSync(dailyFile(e), 'utf8')));
const chapters = await Promise.all([1, 2, 3, 4].map(n => import(`../src/content/generated/chapter-${n}.js`).then(m => m.default)));
const STORIES = (await import('../src/content/generated/stories.js')).default;
const E = -1;

test('at least 60 dailies numbered consecutively from No.1 with unique ids', () => {
    const entries = manifest.entries;
    assert.ok(entries.length >= 60, `${entries.length} dailies`);
    entries.forEach((e, i) => assert.equal(e.no, i + 1));
    assert.equal(new Set(entries.map(e => e.id)).size, entries.length);
    assert.ok(entries.every(e => !('date' in e)), 'puzzles are not tied to calendar dates');
    assert.equal(manifest.epoch, undefined, 'runtime manifest must have no calendar gate');
    assert.equal(manifest.version, 3);
});

test('numbered entries are immutable; historical epoch stays in the lock only', () => {
    assert.equal(lock.epoch, '2026-10-13', 'historical lock metadata is unchanged');
    assert.ok(lock.entries.length >= 60);
    for (const old of lock.entries) {
        const now = manifest.entries.find(e => e.no === old.no);
        assert.ok(now, `No.${old.no} still present`);
        assert.deepEqual(now, old, `No.${old.no} unchanged`);
    }
});

test('each daily file exists, matches the manifest and its checksum', () => {
    const expected = new Set(manifest.entries.map(e => `${e.id}.r${e.revision}.json`));
    for (const f of readdirSync(join(ROOT, 'public/daily'))) assert.ok(expected.has(f), `unexpected file ${f}`);
    manifest.entries.forEach((e, i) => {
        assert.ok(existsSync(dailyFile(e)));
        const lv = DAILY[i];
        assert.equal(lv.id, e.id);
        assert.equal(lv.revision, e.revision);
        assert.equal(lv.no, e.no);
        assert.equal(lv.date, undefined);
        assert.equal(lv.mode, 'daily');
        assert.equal(lv.checksum, e.checksum);
        assert.equal(levelChecksum(lv), lv.checksum);
    });
});

test('daily witnesses are valid and pages follow the normal rules', () => {
    for (const lv of DAILY) {
        const w = lv.witness;
        assert.ok(lv.adj.every((l, i) => w[i] >= 0 && w[i] < 4 && l.every(j => w[j] !== w[i])), `${lv.id} witness`);
        lv.fixed.forEach((c, i) => { if (c !== E) assert.equal(w[i], c); });
        assert.ok(lv.adj.length >= 10 && lv.adj.length <= 18, `${lv.id} size ${lv.adj.length}`);
        assert.ok(lv.actions.includes('fill') && lv.actions.includes('erase'));
        assert.ok(!lv.goals.targets && !lv.goals.maxColors, 'daily uses the normal rules');
    }
});

// independent structural signature (different from the generator's)
function signature(lv) {
    const n = lv.adj.length;
    let col = lv.adj.map((l, i) => `${l.length}/${lv.fixed[i]}/${lv.initial ? lv.initial[i] : E}`);
    for (let r = 0; r < 3; r++) col = col.map((c, i) => `${c}[${lv.adj[i].map(j => col[j]).sort().join(';')}]`);
    return `${n}:${col.slice().sort().join('|')}`;
}

test('daily borders preserve every compiled edge exactly once', () => {
    // Daily maps, collection thumbnails and PNG exports all draw borderPaths.
    const parts = d => (d.match(/M[^M]+/g) || []).map(s => s.trim()).sort();
    for (const lv of DAILY) for (const view of [lv, ...(lv.views || [])]) {
        const { inner, outer } = borderPaths(view);
        assert.ok(outer, `${lv.id} has an outer border`);
        assert.deepEqual(parts(`${inner} ${outer}`), parts(view.outline), `${lv.id} edge partition`);
    }
});

test('no structural duplicates (re-skins) across dailies, main pages and stories', () => {
    const all = [...DAILY, ...chapters.flat(), ...STORIES];
    const seen = new Map();
    for (const lv of all) {
        const sig = signature(lv);
        assert.ok(!seen.has(sig), `${lv.id} duplicates ${seen.get(sig)}`);
        seen.set(sig, lv.id);
    }
});

test('all numbered maps can open immediately, including No.60', () => {
    assert.equal(numberedEntry(manifest, 1).id, 'D001');
    assert.equal(numberedEntry(manifest, 60).id, 'D060');
    for (const invalid of [0, -1, 61, 1.5, NaN, '60', null, undefined]) {
        assert.equal(numberedEntry(manifest, invalid), null);
    }
});

test('recommendation resumes a saved session, then picks the first unfinished map', () => {
    const bank = { session: null, records: { D001: { completed: true } } };
    assert.equal(numberedBankPlan(bank, manifest).recommended.id, 'D002');
    assert.equal(numberedBankPlan(bank, manifest).allDone, false);
    const ninth = manifest.entries[8];
    bank.session = { date: '2026-10-13', no: ninth.no, id: ninth.id, revision: ninth.revision };
    assert.equal(numberedBankPlan(bank, manifest).recommended.id, 'D009', 'legacy session resumes by ID');
    bank.session = { ...bank.session, revision: 77 };
    assert.equal(numberedBankPlan(bank, manifest).recommended.id, 'D002', 'stale revision is ignored');
    bank.session = { ...bank.session, id: 'D008', revision: 1 };
    assert.equal(numberedBankPlan(bank, manifest).recommended.id, 'D002', 'mismatched ID is ignored');
});

test('completion is date-free and keyed by stable puzzle IDs', () => {
    const records = Object.fromEntries(manifest.entries.map(e => [e.id, { revision: e.revision, completed: true }]));
    records.unrelated = { completed: true };
    assert.equal(countRestoredMaps(records, manifest), 60);
    const plan = numberedBankPlan({ session: { no: 1, id: 'D001', revision: 1 }, records }, manifest);
    assert.equal(plan.allDone, true);
    assert.equal(plan.recommended.id, 'D001', 'all-completed players can replay');
});

test('No.60 can be recommended regardless of date; progress stays keyed by ID', () => {
    const last = manifest.entries[59];
    const bank = { session: { no: 60, id: last.id, revision: last.revision }, records: {} };
    assert.equal(numberedBankPlan(bank, manifest).recommended.id, last.id);
    bank.records[last.id] = { completed: true };
    assert.equal(numberedBankPlan(bank, manifest).recommended.id, 'D001');
    assert.equal(countRestoredMaps(bank.records, manifest), 1);
});

await run('verify-four-colors-daily');
