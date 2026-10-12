// Daily bank verifier: at least 60 reviewed puzzles on consecutive UTC+8
// dates, an immutable dated manifest (content/daily-lock.json), files that
// match their checksums, valid witnesses, no structural duplicates across the
// whole game, and the UTC+8 date helpers at their boundaries.

import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test, run } from './lib/harness.mjs';
import manifest from '../src/content/generated/daily-manifest.js';
import { levelChecksum } from '../src/content/checksum.js';
import { utc8Date, msUntilNextDay, dailyStatus, dailySessionPlan, featuredEntries, formatCountdown } from '../src/services/daily.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(readFileSync(join(ROOT, 'content/daily-lock.json'), 'utf8'));
const dailyFile = e => join(ROOT, 'public/daily', `${e.id}.r${e.revision}.json`);
const DAILY = manifest.entries.map(e => JSON.parse(readFileSync(dailyFile(e), 'utf8')));
const chapters = await Promise.all([1, 2, 3, 4].map(n => import(`../src/content/generated/chapter-${n}.js`).then(m => m.default)));
const STORIES = (await import('../src/content/generated/stories.js')).default;
const E = -1;

const nextDate = d => {
    const [y, m, dd] = d.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, dd + 1));
    return t.toISOString().slice(0, 10);
};

test('at least 60 dailies on consecutive dates with unique ids', () => {
    const entries = manifest.entries;
    assert.ok(entries.length >= 60, `${entries.length} dailies`);
    for (let i = 1; i < entries.length; i++) assert.equal(entries[i].date, nextDate(entries[i - 1].date));
    assert.equal(new Set(entries.map(e => e.id)).size, entries.length);
});

test('dated manifest is immutable: every locked entry is unchanged', () => {
    assert.ok(lock.entries.length >= 60);
    for (const old of lock.entries) {
        const now = manifest.entries.find(e => e.date === old.date);
        assert.ok(now, `${old.date} still dated`);
        assert.deepEqual(now, old, `${old.date} unchanged`);
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
        assert.equal(lv.date, e.date);
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

test('no structural duplicates (re-skins) across dailies, main pages and stories', () => {
    const all = [...DAILY, ...chapters.flat(), ...STORIES];
    const seen = new Map();
    for (const lv of all) {
        const sig = signature(lv);
        assert.ok(!seen.has(sig), `${lv.id} duplicates ${seen.get(sig)}`);
        seen.set(sig, lv.id);
    }
});

test('featured picks exist and are dated entries', () => {
    assert.equal(manifest.featured.length, 12);
    assert.equal(featuredEntries(manifest).length, 12);
});

test('UTC+8 day boundaries', () => {
    assert.equal(utc8Date(Date.parse('2026-10-12T15:59:59Z')), '2026-10-12');
    assert.equal(utc8Date(Date.parse('2026-10-12T16:00:00Z')), '2026-10-13');
    assert.equal(utc8Date(Date.parse('2026-12-31T16:30:00Z')), '2027-01-01');
    assert.equal(msUntilNextDay(Date.parse('2026-10-12T15:59:00Z')), 60_000);
    assert.equal(msUntilNextDay(Date.parse('2026-10-12T16:00:00Z')), 24 * 3600 * 1000);
    assert.equal(formatCountdown(3 * 3600 * 1000 + 5 * 60 * 1000), '3:05');
});

test('daily status: before start, today, expired', () => {
    const first = manifest.entries[0].date;
    const last = manifest.entries[manifest.entries.length - 1].date;
    assert.equal(dailyStatus(manifest, first).state, 'today');
    assert.equal(dailyStatus(manifest, '2020-01-01').state, 'before');
    assert.equal(dailyStatus(manifest, nextDate(last)).state, 'expired');
});

test('a session started before midnight stays locked to its puzzle', () => {
    const [d1, d2] = manifest.entries;
    const daily = { session: { date: d1.date, id: d1.id, revision: d1.revision }, records: {} };
    const plan = dailySessionPlan(daily, manifest, d2.date);
    assert.deepEqual(plan.unfinishedOld, daily.session, 'yesterday’s unfinished map is still offered');
    assert.equal(plan.newDay, true);
    assert.equal(plan.status.entry.id, d2.id);
    const done = dailySessionPlan({ ...daily, records: { [d1.date]: { completed: true } } }, manifest, d2.date);
    assert.equal(done.unfinishedOld, null);
});

await run('verify-four-colors-daily');
