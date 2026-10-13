// Daily bank verifier: at least 60 reviewed puzzles numbered No.1…N, an
// immutable released manifest (content/daily-lock.json, epoch included),
// files that match their checksums, valid witnesses, no structural duplicates
// across the whole game, and the UTC+8 "today's number" rule at its edges.

import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test, run } from './lib/harness.mjs';
import manifest from '../src/content/generated/daily-manifest.js';
import { levelChecksum } from '../src/content/checksum.js';
import { borderPaths } from '../src/render/scenery.js';
import { utc8Date, msUntilNextDay, dailyStatus, dailySessionPlan, formatCountdown, dailyNumber, dateOfNumber, isReleased, archiveEntries } from '../src/services/daily.js';
import { DAILY_EPOCH } from '../tools/levels/daily.mjs';

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
    assert.equal(manifest.epoch, DAILY_EPOCH);
});

test('released numbers and the epoch are immutable', () => {
    assert.equal(lock.epoch, manifest.epoch, 'epoch matches the lock');
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

test('today’s number follows UTC+8 days since the epoch', () => {
    const at = (date, time) => Date.parse(`${date}T${time}Z`);
    assert.equal(utc8Date(at('2026-10-12', '15:59:59')), '2026-10-12');
    assert.equal(utc8Date(at('2026-10-12', '16:00:00')), '2026-10-13');
    assert.equal(utc8Date(at('2026-12-31', '16:30:00')), '2027-01-01');
    assert.equal(msUntilNextDay(at('2026-10-12', '15:59:00')), 60_000);
    assert.equal(msUntilNextDay(at('2026-10-12', '16:00:00')), 24 * 3600 * 1000);
    assert.equal(formatCountdown(3 * 3600 * 1000 + 5 * 60 * 1000), '3:05');
    const m = { epoch: '2026-10-13', entries: manifest.entries };
    assert.equal(dailyNumber(m, '2026-10-13'), 1);
    assert.equal(dailyNumber(m, '2026-10-14'), 2);
    assert.equal(dailyNumber(m, '2026-11-12'), 31);
    assert.equal(dailyNumber(m, '2027-01-01'), 81, 'across a year boundary');
    assert.equal(dateOfNumber(m, 31), '2026-11-12');
    // the switch happens at midnight UTC+8 (16:00 UTC), not at local midnight
    assert.equal(dailyNumber(m, utc8Date(at('2026-10-13', '15:59:59'))), 1);
    assert.equal(dailyNumber(m, utc8Date(at('2026-10-13', '16:00:00'))), 2);
});

test('status before the epoch, during the bank and after it runs out', () => {
    const m = manifest;
    const last = m.entries.length;
    assert.equal(dailyStatus(m, '2020-01-01').state, 'before');
    const first = dailyStatus(m, m.epoch);
    assert.equal(first.state, 'today');
    assert.equal(first.entry.no, 1);
    assert.equal(dailyStatus(m, dateOfNumber(m, last)).entry.no, last);
    const after = dailyStatus(m, dateOfNumber(m, last + 1));
    assert.equal(after.state, 'expired');
    assert.equal(archiveEntries(m, dateOfNumber(m, last + 1)).length, last, 'every number stays playable after the bank runs out');
});

test('only released numbers can be opened; the archive lists earlier ones', () => {
    const m = manifest;
    const d5 = dateOfNumber(m, 5);
    assert.ok(isReleased(m, d5, 5));
    assert.ok(isReleased(m, d5, 1));
    assert.ok(!isReleased(m, d5, 6), 'future numbers are not opened early');
    assert.ok(!isReleased(m, d5, 0));
    assert.deepEqual(archiveEntries(m, d5).map(e => e.no), [4, 3, 2, 1]);
});

test('a number opened before midnight stays the same puzzle afterwards', () => {
    const m = manifest;
    const [e1, e2] = m.entries;
    const day1 = dateOfNumber(m, 1);
    const day2 = dateOfNumber(m, 2);
    const daily = { session: { date: day1, no: 1, id: e1.id, revision: e1.revision }, records: {} };
    const plan = dailySessionPlan(daily, m, day2);
    assert.deepEqual(plan.unfinishedOld, daily.session, 'yesterday’s unfinished No.1 is still offered');
    assert.equal(plan.newDay, true);
    assert.equal(plan.status.entry.id, e2.id);
    assert.ok(isReleased(m, day2, 1), 'No.1 can still be finished on day two');
    const done = dailySessionPlan({ ...daily, records: { [e1.id]: { completed: true } } }, m, day2);
    assert.equal(done.unfinishedOld, null);
});

await run('verify-four-colors-daily');
