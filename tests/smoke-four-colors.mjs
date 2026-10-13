// Browser regression for the built site (dist/). Covers the first minute,
// painting, conflicts, undo/redo, completion records, restore after reload,
// keyboard, pointer edge cases (cancel, two fingers, drag, long press), the
// two-color swap (preview, locks, conflicts), hints (layers, stale replies,
// timeout), visible-viewport fit, settings precedence, storage failure,
// multi-tab conflicts, the daily lock across midnight, the collection,
// reduced motion, lifecycle saving and main-thread budgets.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { startServer } from './lib/serve.mjs';
import manifest from '../src/content/generated/daily-manifest.js';
import { dateOfNumber } from '../src/services/daily.js';

const DIST = process.env.SMOKE_DIR || 'dist';
if (!existsSync(`${DIST}/index.html`)) {
    console.error(`${DIST}/index.html missing — run npm run build first`);
    process.exit(1);
}

const srv = await startServer(DIST);
const BASE = `http://127.0.0.1:${srv.port}/`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const results = [];
const SAVE_KEY = 'game:four-colors:v1:save';
const SETTINGS_KEY = 'game:four-colors:v1:settings';

async function scenario(name, fn) {
    const t0 = Date.now();
    try {
        await fn();
        results.push({ name, ok: true });
        console.log(`  ✓ ${name} (${Date.now() - t0}ms)`);
    } catch (err) {
        results.push({ name, ok: false });
        console.error(`  ✗ ${name}\n    ${String(err && err.stack || err).split('\n').slice(0, 6).join('\n    ')}`);
    }
}

async function open({ hash = '', viewport = { width: 390, height: 664 }, locale = 'zh-CN', seed = null, init = null, touch = false, context = null, reducedMotion = 'no-preference', clock = null } = {}) {
    const ctx = context || await browser.newContext({ viewport, locale, hasTouch: touch, isMobile: touch, reducedMotion, acceptDownloads: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    if (clock) await page.clock.install({ time: clock });
    if (seed) await page.addInitScript(([k, v]) => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem(k, v); sessionStorage.setItem('seeded', '1'); } }, [SAVE_KEY, JSON.stringify(seed)]);
    if (init) await page.addInitScript(init);
    await page.goto(BASE + hash);
    await page.waitForFunction(() => window.__fourColors && document.querySelector('.view > *'));
    return { page, ctx, errors };
}

const seedDone = ids => ({
    schema: 1, writeSeq: 1, writer: 'seed', visited: true, current: null, sessions: {},
    progress: Object.fromEntries(ids.map(id => [id, { revision: 1, completed: true, independent: true }])),
    daily: { session: null, records: {} }, collection: [],
});

async function waitPlay(page, id) {
    await page.waitForFunction(i => window.__fourColors.play && window.__fourColors.play.level.id === i, id);
    await page.waitForTimeout(80);
}

async function point(page, i) {
    return page.evaluate(idx => {
        const [x, y] = window.__fourColors.play.level.labels[idx];
        const svgEl = document.querySelector('svg.map');
        const q = svgEl.createSVGPoint();
        q.x = x;
        q.y = y;
        const r = q.matrixTransform(svgEl.getScreenCTM());
        return [r.x, r.y];
    }, i);
}

async function tap(page, i) {
    const [x, y] = await point(page, i);
    await page.mouse.click(x, y);
}

const colors = page => page.evaluate(() => window.__fourColors.play.state.colors.slice());
const statusText = page => page.locator('#status').textContent();
const pickColor = (page, c) => page.click(`.paint[data-c="${c}"]`);
const openTray = async page => { if (await page.locator('.tray').isHidden()) await page.click('.dock-actions .icon-btn:last-child'); };

async function solveFromWitness(page) {
    const lv = await page.evaluate(() => {
        const p = window.__fourColors.play;
        return { witness: p.level.witness, fixed: p.level.fixed, colors: p.state.colors };
    });
    for (let i = 0; i < lv.witness.length; i++) {
        if (lv.fixed[i] >= 0 || lv.colors[i] === lv.witness[i]) continue;
        await pickColor(page, lv.witness[i]);
        await tap(page, i);
    }
}

async function dispatchPointer(page, i, type, { id = 1, dx = 0, dy = 0 } = {}) {
    const [x, y] = await point(page, i);
    await page.evaluate(([t, px, py, pid]) => {
        const target = document.elementFromPoint(px, py);
        target.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, pointerId: pid, pointerType: 'touch', isPrimary: pid === 1, clientX: px, clientY: py, button: 0 }));
    }, [type, x + dx, y + dy, id]);
}

console.log('smoke-four-colors');

await scenario('first visit opens page one directly and teaches by doing', async () => {
    const { page, ctx, errors } = await open();
    await waitPlay(page, 'FC01');
    assert.equal(new URL(page.url()).hash, '#/p/FC01');
    assert.equal(await page.locator('.region').count(), 4);
    assert.equal(await page.locator('.paint').count(), 4);
    assert.match(await statusText(page), /选一枚颜料/);
    assert.equal(await page.locator('.map-host').getAttribute('role'), 'application');
    assert.ok((await page.locator('.paint[data-c="0"]').getAttribute('aria-label')).includes('朱砂'));
    // tapping before choosing a pigment does nothing but point at the palette
    await tap(page, 0);
    assert.deepEqual(await colors(page), [-1, -1, -1, -1]);
    assert.ok(await page.locator('.palette.pulse').count());
    assert.deepEqual(errors, []);
    await ctx.close();
});

await scenario('painting, conflict borders, undo and redo', async () => {
    const { page, ctx } = await open({ hash: '#/p/FC01' });
    await waitPlay(page, 'FC01');
    const adj = await page.evaluate(() => window.__fourColors.play.level.adj);
    const [a, b] = [0, adj[0][0]];
    await pickColor(page, 1);
    await tap(page, a);
    await tap(page, b);
    await page.waitForTimeout(250);
    assert.equal(await page.locator('.layer-conflicts .conflict').count(), 1);
    assert.match(await statusText(page), /相邻同色/);
    await page.click('.dock-actions .icon-btn:first-child');
    assert.equal(await page.locator('.layer-conflicts .conflict').count(), 0);
    await openTray(page);
    await page.click('.tray-redo');
    assert.equal(await page.locator('.layer-conflicts .conflict').count(), 1);
    await ctx.close();
});

await scenario('completion: records, seal, landmarks and next page without a blocking dialog', async () => {
    const { page, ctx, errors } = await open({ hash: '#/p/FC01' });
    await waitPlay(page, 'FC01');
    await solveFromWitness(page);
    await page.waitForSelector('.complete-bar:not([hidden])');
    assert.ok(await page.locator('.page.is-complete').count());
    assert.match(await statusText(page), /修复完成/);
    assert.equal(await page.locator('dialog[open]').count(), 0, 'no modal over the map');
    await page.waitForTimeout(100);
    const save = await page.evaluate(k => JSON.parse(localStorage.getItem(k)), SAVE_KEY);
    assert.equal(save.progress.FC01.completed, true);
    assert.equal(save.progress.FC01.independent, true);
    await page.click('.complete-bar .btn-primary');
    await waitPlay(page, 'FC02');
    assert.deepEqual(errors, []);
    await ctx.close();
});

await scenario('progress and history survive a reload', async () => {
    const { page, ctx } = await open({ hash: '#/p/FC02', seed: seedDone(['FC01']) });
    await waitPlay(page, 'FC02');
    await pickColor(page, 2);
    await tap(page, 0);
    await pickColor(page, 3);
    await tap(page, 1);
    await page.waitForTimeout(400);
    await page.reload();
    await waitPlay(page, 'FC02');
    const c = await colors(page);
    assert.equal(c[0], 2);
    assert.equal(c[1], 3);
    await page.click('.dock-actions .icon-btn:first-child');
    assert.equal((await colors(page))[1], -1, 'undo works after reload');
    await ctx.close();
});

await scenario('keyboard: arrows, 1–4, Enter, Backspace, Ctrl+Z', async () => {
    const { page, ctx } = await open({ hash: '#/p/FC04', seed: seedDone(['FC01', 'FC02', 'FC03']) });
    await waitPlay(page, 'FC04');
    await page.focus('.map-host');
    await page.keyboard.press('ArrowDown');
    const f = await page.evaluate(() => window.__fourColors.play.focus);
    assert.ok(f >= 0);
    assert.equal(await page.locator('.focus-ring').count(), 1);
    await page.keyboard.press('3');
    await page.keyboard.press('Enter');
    assert.equal((await colors(page))[f], 2);
    await page.keyboard.press('Backspace');
    assert.equal((await colors(page))[f], -1);
    await page.keyboard.press('Control+z');
    assert.equal((await colors(page))[f], 2);
    await page.keyboard.press('ArrowRight');
    const g = await page.evaluate(() => window.__fourColors.play.focus);
    assert.notEqual(g, f);
    await ctx.close();
});

await scenario('pointer edge cases: cancel, second finger, drag and long press never paint', async () => {
    const { page, ctx } = await open({ hash: '#/p/FC04', seed: seedDone(['FC01', 'FC02', 'FC03']), touch: true });
    await waitPlay(page, 'FC04');
    await pickColor(page, 0);
    // pointercancel (a scroll or pinch took over)
    await dispatchPointer(page, 0, 'pointerdown');
    await dispatchPointer(page, 0, 'pointercancel');
    await dispatchPointer(page, 0, 'pointerup');
    // second finger
    await dispatchPointer(page, 1, 'pointerdown', { id: 1 });
    await dispatchPointer(page, 1, 'pointerdown', { id: 2, dx: 30 });
    await dispatchPointer(page, 1, 'pointerup', { id: 1 });
    await dispatchPointer(page, 1, 'pointerup', { id: 2, dx: 30 });
    // drag
    await dispatchPointer(page, 2, 'pointerdown');
    await dispatchPointer(page, 2, 'pointermove', { dx: 25 });
    await dispatchPointer(page, 2, 'pointerup', { dx: 25 });
    // long press shows the region instead
    await dispatchPointer(page, 3, 'pointerdown');
    await page.waitForTimeout(700);
    await dispatchPointer(page, 3, 'pointerup');
    assert.deepEqual((await colors(page)).filter(c => c !== -1), []);
    assert.match(await statusText(page), /相邻/);
    // a clean tap still paints
    await dispatchPointer(page, 0, 'pointerdown');
    await dispatchPointer(page, 0, 'pointerup');
    assert.equal((await colors(page))[0], 0);
    await ctx.close();
});

await scenario('swap FC26: preview of a one-region component, atomic confirm and undo', async () => {
    const { page, ctx } = await open({ hash: '#/p/FC26', seed: seedDone([]) });
    await waitPlay(page, 'FC26');
    assert.ok(await page.locator('.play.swap-only').count());
    await pickColor(page, 0);
    await pickColor(page, 2);
    await tap(page, 2);
    assert.match(await page.locator('.swap-bar .bar-text').textContent(), /只有 1 块/);
    assert.equal(await page.locator('.layer-preview .lift').count(), 1, 'A (also 0) is not lifted');
    await page.click('.swap-bar .btn-primary');
    assert.deepEqual(await colors(page), [0, 1, 0, 1]);
    await page.waitForSelector('.complete-bar:not([hidden])');
    await page.click('.complete-bar .btn-ghost');
    await page.click('.dock-actions .icon-btn:first-child');
    assert.deepEqual(await colors(page), [0, 1, 2, 1]);
    await ctx.close();
});

await scenario('swap never truncates at a lock, and is refused while neighbours match', async () => {
    const { page, ctx } = await open({ hash: '#/s/S1', seed: seedDone(['FC08', 'FC26']) });
    await waitPlay(page, 'S1');
    const { anchor, c } = await page.evaluate(() => {
        const lv = window.__fourColors.play.level;
        const i = lv.fixed.findIndex(x => x >= 0);
        return { anchor: i, c: lv.fixed[i] };
    });
    const other = (c + 1) % 4;
    await pickColor(page, c);
    await pickColor(page, other);
    await tap(page, anchor);
    assert.ok(await page.locator('.swap-bar .btn-primary').isDisabled());
    assert.match(await statusText(page), /固定印章/);
    assert.ok(await page.locator('.layer-preview .locked-hatch').count() >= 1);
    await ctx.close();

    const second = await open({ hash: '#/p/FC25', seed: seedDone(['FC01', 'FC02', 'FC03', 'FC04', 'FC05', 'FC06', 'FC07', 'FC08', 'FC09', 'FC10', 'FC11', 'FC12', 'FC13', 'FC14', 'FC15', 'FC16', 'FC17', 'FC18', 'FC19', 'FC20', 'FC21', 'FC22', 'FC23', 'FC24']) });
    const p2 = second.page;
    await waitPlay(p2, 'FC25');
    const hole = await p2.evaluate(() => window.__fourColors.play.state.colors.indexOf(-1));
    await pickColor(p2, 0);
    await tap(p2, hole); // every color touches the hole, so this creates a conflict
    await openTray(p2);
    await p2.click('.tray-swap');
    await pickColor(p2, 1);
    await pickColor(p2, 2);
    const some = await p2.evaluate(() => window.__fourColors.play.state.colors.findIndex(x => x === 1 || x === 2));
    await tap(p2, some);
    assert.match(await statusText(p2), /先解决相邻同色/);
    assert.equal(await p2.locator('.swap-bar').isHidden(), true);
    await second.ctx.close();
});

await scenario('hints: layered, honest “must be”, and recorded as assisted', async () => {
    const { page, ctx } = await open({ hash: '#/p/FC08', seed: seedDone(['FC01', 'FC02', 'FC03', 'FC04', 'FC05', 'FC06', 'FC07']) });
    await waitPlay(page, 'FC08');
    for (const [i, c] of [[0, 0], [1, 1], [2, 2]]) { await pickColor(page, c); await tap(page, i); }
    await openTray(page);
    await page.click('.tray-hint');
    await page.waitForFunction(() => !window.__fourColors.play.hintPending && window.__fourColors.play.hint);
    assert.equal(await page.locator('.hint-region').count(), 1);
    await page.click('.tray-hint');
    await page.waitForFunction(() => window.__fourColors.play.hintLayer === 2);
    assert.match(await statusText(page), /只能是/);
    await pickColor(page, 3);
    await tap(page, 3);
    await page.waitForSelector('.complete-bar:not([hidden])');
    await page.waitForTimeout(100);
    const save = await page.evaluate(k => JSON.parse(localStorage.getItem(k)), SAVE_KEY);
    assert.equal(save.progress.FC08.completed, true);
    assert.equal(save.progress.FC08.independent, false);
    await ctx.close();
});

await scenario('hints: a reply for an older state is dropped; a silent worker times out', async () => {
    const slowWorker = () => {
        const Real = window.Worker;
        window.Worker = class extends Real {
            postMessage(msg) { setTimeout(() => super.postMessage(msg), 400); }
        };
    };
    const { page, ctx } = await open({ hash: '#/p/FC04', seed: seedDone(['FC01', 'FC02', 'FC03']), init: slowWorker });
    await waitPlay(page, 'FC04');
    await openTray(page);
    await page.click('.tray-hint');
    await pickColor(page, 0);
    await tap(page, 0); // state changes while the hint is in flight: it is cancelled at once
    await page.waitForFunction(() => !window.__fourColors.play.hintPending, null, { timeout: 300 });
    await page.waitForTimeout(700);
    assert.equal(await page.evaluate(() => window.__fourColors.play.hint), null);
    assert.doesNotMatch(await statusText(page), /看看/);
    await ctx.close();

    const silent = () => { window.Worker = class { postMessage() {} terminate() {} }; };
    const s = await open({ hash: '#/p/FC04', seed: seedDone(['FC01', 'FC02', 'FC03']), init: silent });
    await waitPlay(s.page, 'FC04');
    const before = await colors(s.page);
    await openTray(s.page);
    await s.page.click('.tray-hint');
    await s.page.waitForFunction(() => /暂时无法给出建议/.test(document.getElementById('status').textContent), null, { timeout: 5000 });
    assert.deepEqual(await colors(s.page), before, 'timeout never changes the page');
    await s.ctx.close();
});

await scenario('a fill animation interrupted by undo settles on committed state', async () => {
    const { page, ctx } = await open({ hash: '#/p/FC04', seed: seedDone(['FC01', 'FC02', 'FC03']) });
    await waitPlay(page, 'FC04');
    await pickColor(page, 1);
    await tap(page, 0);
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(350);
    assert.equal((await colors(page))[0], -1);
    assert.equal(await page.locator('.region[data-i="0"]').getAttribute('data-c'), '-1');
    assert.equal(await page.locator('.spread').count(), 0);
    await ctx.close();
});

for (const vp of [{ width: 390, height: 664 }, { width: 375, height: 553 }, { width: 320, height: 454 }, { width: 839, height: 360 }]) {
    await scenario(`visible viewport ${vp.width}×${vp.height}: no overflow, tools on screen, every region tappable`, async () => {
        const all = ['FC01', 'FC02', 'FC03', 'FC04', 'FC05', 'FC06', 'FC07', 'FC08', 'FC09', 'FC10', 'FC11', 'FC12', 'FC13', 'FC14', 'FC15', 'FC16', 'FC17', 'FC18', 'FC19', 'FC20', 'FC21', 'FC22', 'FC23', 'FC24', 'FC25', 'FC26', 'FC27', 'FC28', 'FC29', 'FC30', 'FC31'];
        const { page, ctx } = await open({ hash: '#/p/FC32', viewport: vp, seed: seedDone(all), touch: true });
        for (const id of ['FC32', 'FC16', 'FC24', 'S8']) {
            await page.evaluate(h => { location.hash = h; }, id.startsWith('S') ? `#/s/${id}` : `#/p/${id}`);
            await waitPlay(page, id);
            const res = await page.evaluate(() => {
                const p = window.__fourColors.play;
                const svgEl = document.querySelector('svg.map');
                const m = svgEl.getScreenCTM();
                const bad = [];
                p.level.labels.forEach(([x, y], i) => {
                    const q = svgEl.createSVGPoint();
                    q.x = x; q.y = y;
                    const r = q.matrixTransform(m);
                    const hit = document.elementFromPoint(r.x, r.y);
                    const node = hit && hit.closest('[data-i]');
                    if (!node || Number(node.getAttribute('data-i')) !== i) bad.push(p.level.ids[i]);
                });
                const rect = el => el.getBoundingClientRect();
                const dock = rect(document.querySelector('.dock-main'));
                return {
                    bad,
                    overflowX: document.documentElement.scrollWidth > innerWidth,
                    dockInside: dock.bottom <= innerHeight + 0.5 && dock.right <= innerWidth + 0.5 && dock.left >= -0.5,
                    scale: m.a,
                    minR: Math.min(...p.level.labels.map(l => l[2])) * m.a,
                };
            });
            assert.deepEqual(res.bad, [], `${id}: regions not hittable at their label points`);
            assert.equal(res.overflowX, false, `${id}: horizontal overflow`);
            assert.ok(res.dockInside, `${id}: dock outside the visible viewport`);
            assert.ok(res.minR >= 9, `${id}: smallest region radius ${res.minR.toFixed(1)}px on screen`);
        }
        await ctx.close();
    });
}

await scenario('rotation keeps every region tappable', async () => {
    const { page, ctx } = await open({ hash: '#/p/FC12', seed: seedDone(['FC01', 'FC02', 'FC03', 'FC04', 'FC05', 'FC06', 'FC07', 'FC08', 'FC09', 'FC10', 'FC11']) });
    await waitPlay(page, 'FC12');
    await page.setViewportSize({ width: 664, height: 390 });
    await page.waitForTimeout(250);
    await pickColor(page, 0);
    await tap(page, 3);
    assert.equal((await colors(page))[3], 0);
    await ctx.close();
});

await scenario('settings: language and theme apply and persist; entry params never override stored ones', async () => {
    const { page, ctx } = await open({ hash: '#/atlas/ch1', seed: seedDone(['FC01']) });
    await page.click('.topbar-right .icon-btn:last-child');
    await page.locator('label.choice', { has: page.locator('input[name="lang"][value="en"]') }).click();
    await page.locator('label.choice', { has: page.locator('input[name="theme"][value="dark"]') }).click();
    await page.click('.settings-sheet .btn-primary');
    assert.equal(await page.locator('.cover-title').textContent(), 'Fourfold Atlas');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    await page.reload();
    await page.waitForSelector('.cover-title');
    assert.equal(await page.locator('.cover-title').textContent(), 'Fourfold Atlas');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    await page.goto(`${BASE}?lang=zh&theme=light&keep=1#/atlas/ch1`);
    await page.waitForSelector('.cover-title');
    assert.equal(await page.locator('.cover-title').textContent(), 'Fourfold Atlas', 'stored language wins');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    assert.equal(new URL(page.url()).search, '?keep=1', 'recognised parameters are removed, others kept');
    assert.equal(JSON.parse(await page.evaluate(k => localStorage.getItem(k), SETTINGS_KEY)).muted, undefined, 'sound is never set by URL');
    await ctx.close();

    const fresh = await open({ hash: '', locale: 'zh-CN', init: () => { history.replaceState(null, '', '/?lang=en#/atlas/ch1'); } });
    await fresh.page.goto(`${BASE}?lang=en#/atlas/ch1`);
    await fresh.page.waitForSelector('.cover-title');
    assert.equal(await fresh.page.locator('.cover-title').textContent(), 'Fourfold Atlas', 'entry parameter seeds a first visit');
    assert.equal(await fresh.page.evaluate(k => localStorage.getItem(k), SETTINGS_KEY), null, 'entry parameter is not stored as a preference');
    await fresh.ctx.close();
});

await scenario('storage failure shows a non-blocking notice and play continues', async () => {
    const breakStorage = () => {
        const set = Storage.prototype.setItem;
        Storage.prototype.setItem = function (k, v) {
            if (String(k).startsWith('game:four-colors')) throw new DOMException('full', 'QuotaExceededError');
            return set.call(this, k, v);
        };
    };
    const { page, ctx, errors } = await open({ hash: '#/p/FC01', init: breakStorage });
    await waitPlay(page, 'FC01');
    await pickColor(page, 0);
    await tap(page, 0);
    await page.waitForSelector('.toast', { timeout: 3000 });
    assert.match(await page.locator('.toast').first().textContent(), /没能保存/);
    assert.doesNotMatch(await page.locator('body').textContent(), /已保存/);
    await tap(page, 1);
    assert.equal((await colors(page))[1], 0);
    assert.deepEqual(errors, []);
    await ctx.close();
});

await scenario('multi-tab: newer progress from another tab is not silently overwritten', async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 664 }, locale: 'zh-CN' });
    const a = await open({ hash: '#/p/FC01', context: ctx });
    const b = await open({ hash: '#/p/FC01', context: ctx });
    await waitPlay(a.page, 'FC01');
    await waitPlay(b.page, 'FC01');
    await pickColor(a.page, 0);
    await tap(a.page, 0);
    await a.page.waitForTimeout(400);
    await pickColor(b.page, 2);
    await tap(b.page, 1);
    await b.page.waitForSelector('.toast .toast-actions', { timeout: 3000 });
    const stored = await b.page.evaluate(k => JSON.parse(localStorage.getItem(k)), SAVE_KEY);
    assert.equal(stored.sessions['FC01@1'].colors[0], 0, "tab A's write is intact");
    await b.page.click('.toast .toast-actions .btn:not(.btn-primary)');
    const after = await b.page.evaluate(k => JSON.parse(localStorage.getItem(k)), SAVE_KEY);
    assert.equal(after.sessions['FC01@1'].colors[1], 2, 'keeping this tab writes it deliberately');
    await ctx.close();
});

await scenario('daily: numbered puzzles, today by UTC+8 day, kept across midnight, archive', async () => {
    const entry = manifest.entries[8]; // No.9
    const t1 = Date.parse(`${dateOfNumber(manifest, entry.no)}T15:50:00Z`); // 23:50 UTC+8 on No.9's day
    const { page, ctx, errors } = await open({ hash: '#/daily', clock: t1, seed: seedDone(['FC01']) });
    await waitPlay(page, entry.id);
    assert.equal(new URL(page.url()).hash, '#/daily/9', 'the number is carried in the URL');
    assert.match(await page.locator('.topbar-title .title').textContent(), /No\.9/);
    const [r0, r1] = await page.evaluate(() => window.__fourColors.play.level.fixed.map((c, i) => (c < 0 ? i : -1)).filter(i => i >= 0));
    await pickColor(page, 0);
    await tap(page, r0);
    await page.clock.setSystemTime(t1 + 20 * 60 * 1000); // 00:10 UTC+8, No.10's day
    await pickColor(page, 1);
    await tap(page, r1);
    assert.equal(await page.evaluate(() => window.__fourColors.play.level.id), entry.id, 'same puzzle after midnight');
    await page.reload();
    await waitPlay(page, entry.id);
    assert.equal((await colors(page))[r1], 1, 'reloading after midnight still finishes No.9');
    await page.evaluate(() => { location.hash = '#/atlas/daily'; });
    await page.waitForSelector('.daily');
    const panel = await page.locator('.tab-panel').textContent();
    assert.match(panel, /新的一天/);
    assert.match(panel, /No\.10/);
    assert.match(panel, /继续 No\.9/);
    assert.equal(await page.locator('.daily-tile').count(), 9, 'No.1–No.9 are in the archive');
    await page.evaluate(() => { location.hash = '#/daily/11'; });
    await page.waitForSelector('.atlas');
    assert.equal(new URL(page.url()).hash, '#/atlas/daily', 'future numbers do not open early');
    await page.evaluate(() => { location.hash = '#/daily'; });
    await waitPlay(page, manifest.entries[9].id);
    await page.evaluate(() => { location.hash = '#/daily/3'; });
    await waitPlay(page, manifest.entries[2].id);
    assert.deepEqual(errors, []);
    await ctx.close();
});

await scenario('daily: a failed download offers a retry instead of breaking the page', async () => {
    srv.server.failDaily = true;
    const { page, ctx } = await open({ hash: '#/daily', clock: Date.parse(`${dateOfNumber(manifest, 4)}T04:00:00Z`), seed: seedDone(['FC01']) });
    await page.waitForSelector('.toast .toast-actions', { timeout: 5000 });
    assert.match(await page.locator('.toast').textContent(), /暂时无法载入/);
    srv.server.failDaily = false;
    await page.click('.toast .btn-primary'); // Retry alone must refetch and open the daily
    await waitPlay(page, manifest.entries[3].id);
    assert.equal(new URL(page.url()).hash, '#/daily/4');
    await ctx.close();
});

await scenario('collection: recolor a restored page, save it, export it', async () => {
    const { page, ctx } = await open({ hash: '#/p/FC01', seed: seedDone([]) });
    await waitPlay(page, 'FC01');
    await solveFromWitness(page);
    await page.waitForSelector('.complete-bar:not([hidden])');
    await page.click('.complete-bar a[href="#/collect/FC01"]');
    await page.waitForSelector('.collect-bar:not([hidden])');
    assert.match(await statusText(page), /自由配色/);
    const before = await page.evaluate(() => JSON.parse(localStorage.getItem('game:four-colors:v1:save')).progress.FC01.solution);
    await pickColor(page, 3);
    await tap(page, 0);
    await page.click('.collect-bar .btn:nth-child(2)');
    await page.waitForTimeout(100);
    const save = await page.evaluate(k => JSON.parse(localStorage.getItem(k)), SAVE_KEY);
    assert.equal(save.collection.length, 1);
    assert.equal(save.collection[0].colors[0], 3);
    assert.deepEqual(save.progress.FC01.solution, before, 'first solve record is not overwritten');
    const download = page.waitForEvent('download');
    await page.click('.collect-bar .btn:nth-child(3)');
    assert.match((await download).suggestedFilename(), /fourfold-atlas-fc01\.png/);
    await page.click('.collect-bar .btn-primary');
    await page.waitForSelector('.collection-card');
    assert.equal(await page.locator('.collection-card').count(), 1);
    await ctx.close();
});

await scenario('reduced motion: painting is immediate', async () => {
    const { page, ctx } = await open({ hash: '#/p/FC01', reducedMotion: 'reduce' });
    await waitPlay(page, 'FC01');
    await pickColor(page, 0);
    await tap(page, 0);
    assert.equal(await page.locator('.spread').count(), 0);
    assert.equal(await page.locator('.region[data-i="0"]').getAttribute('data-c'), '0');
    await ctx.close();
});

await scenario('region list lists every region with neighbours and selects on the map', async () => {
    const { page, ctx } = await open({ hash: '#/p/FC16', seed: seedDone(['FC01', 'FC02', 'FC03', 'FC04', 'FC05', 'FC06', 'FC07', 'FC08', 'FC09', 'FC10', 'FC11', 'FC12', 'FC13', 'FC14', 'FC15']) });
    await waitPlay(page, 'FC16');
    await openTray(page);
    await page.click('.tray-regions');
    assert.equal(await page.locator('.region-row').count(), 11);
    assert.match(await page.locator('.region-row').first().textContent(), /相邻：R1、R2、R3、R4、R5、R6/);
    await page.locator('.region-row .btn').first().click();
    assert.equal(await page.evaluate(() => window.__fourColors.play.focus), 0);
    await ctx.close();
});

await scenario('lifecycle: hiding the page flushes the save immediately', async () => {
    const { page, ctx } = await open({ hash: '#/p/FC01' });
    await waitPlay(page, 'FC01');
    await pickColor(page, 2);
    await tap(page, 2);
    await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
    });
    const s = await page.evaluate(k => JSON.parse(localStorage.getItem(k)), SAVE_KEY);
    assert.equal(s.sessions['FC01@1'].colors[2], 2);
    await ctx.close();
});

await scenario('budgets: commits stay under 8ms and an idle page runs no frame loop', async () => {
    const { page, ctx } = await open({ hash: '#/p/FC32', seed: seedDone(['FC31']) });
    await waitPlay(page, 'FC32');
    const ms = await page.evaluate(() => {
        const g = window.__fourColors;
        const n = g.play.level.adj.length;
        const free = g.play.level.fixed.map((c, i) => (c < 0 ? i : -1)).filter(i => i >= 0);
        const t0 = performance.now();
        for (let k = 0; k < 60; k++) g.commit({ type: 'fill', region: free[k % free.length], color: k % 4 });
        return (performance.now() - t0) / 60 + n * 0;
    });
    assert.ok(ms < 8, `average commit ${ms.toFixed(2)}ms`);
    await page.waitForTimeout(600);
    const frames = await page.evaluate(() => new Promise(resolve => {
        let count = 0;
        const raf = window.requestAnimationFrame;
        window.requestAnimationFrame = cb => { count++; return raf(cb); };
        setTimeout(() => { window.requestAnimationFrame = raf; resolve(count); }, 1500);
    }));
    assert.equal(frames, 0, 'no requestAnimationFrame while idle');
    await ctx.close();
});

await scenario('deep links, browser back and the games collection link', async () => {
    const { page, ctx } = await open({ hash: '#/p/FC20', seed: seedDone([]) });
    await waitPlay(page, 'FC20');
    await page.click('.back-btn');
    await page.waitForSelector('.atlas');
    assert.equal(new URL(page.url()).hash, '#/atlas/ch3');
    await page.goBack();
    await waitPlay(page, 'FC20');
    await page.evaluate(() => { location.hash = '#/atlas/ch1'; });
    await page.waitForSelector('.games-link');
    assert.equal(await page.locator('.games-link').getAttribute('href'), 'https://games.orangely.xyz/');
    await page.evaluate(() => { location.hash = '#/full'; });
    await page.waitForSelector('.mosaic-cell');
    assert.equal(await page.locator('.mosaic-cell').count(), 32);
    await ctx.close();
});

await browser.close();
await srv.close();
const failed = results.filter(r => !r.ok).length;
if (failed) {
    console.error(`smoke-four-colors: ${failed} of ${results.length} failed`);
    process.exit(1);
}
console.log(`smoke-four-colors: ${results.length} passed`);
