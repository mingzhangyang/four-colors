// The atlas: cover, chapter pages, repair stories, the daily map and the
// collection. Same book, different states — no separate menu screens.

import { el, svg, clear, icon } from './dom.js';
import { t, tx } from '../i18n.js';
import { CHAPTERS, chapterById } from '../content/chapters.js';
import { EMPTY } from '../model/rules.js';

export const TABS = ['ch1', 'ch2', 'ch3', 'ch4', 'stories', 'daily', 'collection'];

export function thumb(level, colors, palette, { label = '' } = {}) {
    const [x, y, w, h] = level.box;
    const node = svg('svg', { class: 'thumb', viewBox: `${x} ${y} ${w} ${h}`, 'aria-hidden': 'true', preserveAspectRatio: 'xMidYMid meet' });
    if (level.water) node.append(svg('rect', { class: 'thumb-sea', x, y, width: w, height: h }));
    level.paths.forEach((d, i) => {
        const c = colors ? colors[i] : EMPTY;
        node.append(svg('path', { d, class: 'thumb-region', style: c >= 0 ? `fill:${palette[c]}` : null }));
    });
    node.append(svg('path', { class: 'thumb-ink', d: level.outline }));
    if (label) node.setAttribute('aria-label', label);
    return node;
}

function statusLine(rec, inProgress) {
    if (rec && rec.completed) {
        const parts = [t('level.completed')];
        if (rec.independent) parts.push(t('level.independent'));
        if (rec.challenge) parts.push(t('level.challenge'));
        return parts.join(' · ');
    }
    return inProgress ? t('level.inProgress') : '';
}

function card({ href, number, name, meta, locked, done, independent, challenge, thumbNode, ariaLabel }) {
    const tag = locked ? 'div' : 'a';
    const node = el(tag, {
        class: `level-card${locked ? ' is-locked' : ''}${done ? ' is-done' : ''}`,
        href: locked ? null : href,
        'aria-label': ariaLabel,
        'aria-disabled': locked ? 'true' : null,
    }, [
        el('div', { class: 'card-thumb' }, [thumbNode || el('div', { class: 'thumb-placeholder' }),
            done ? el('span', { class: `card-stamp${independent ? ' independent' : ''}` }, [icon('check')]) : null,
            challenge ? el('span', { class: 'card-challenge' }, [icon('star')]) : null,
            locked ? el('span', { class: 'card-lock' }, [icon('lock')]) : null]),
        el('div', { class: 'card-text' }, [
            el('span', { class: 'card-number' }, [number]),
            el('span', { class: 'card-name' }, [name]),
            meta ? el('span', { class: 'card-meta' }, [meta]) : null,
        ]),
    ]);
    return node;
}

export function createAtlasView(ctx) {
    const root = el('section', { class: 'atlas', 'aria-labelledby': 'atlas-title' });
    const cover = el('header', { class: 'cover' });
    const tabs = el('nav', { class: 'tabs', role: 'tablist', 'aria-label': t('tabs.label') });
    const panel = el('div', { class: 'tab-panel', role: 'tabpanel', tabindex: '-1' });
    const foot = el('footer', { class: 'atlas-foot' });
    root.append(cover, tabs, panel, foot);
    let renderToken = 0;

    function tabLabel(tab) {
        if (tab.startsWith('ch')) return tx(chapterById(Number(tab.slice(2))).name);
        return t(`tabs.${tab}`);
    }

    function renderCover() {
        clear(cover);
        const done = ctx.mainDoneCount();
        const total = ctx.mainTotal();
        const mark = svg('svg', { class: 'cover-mark', viewBox: '0 0 240 240', 'aria-hidden': 'true' }, [
            svg('path', { d: 'M120 120L120 20A100 100 0 0 1 206.6 170Z', class: 'm0' }),
            svg('path', { d: 'M120 120L206.6 170A100 100 0 0 1 33.4 170Z', class: 'm1' }),
            svg('path', { d: 'M120 120L33.4 170A100 100 0 0 1 120 20Z', class: 'm2' }),
            svg('circle', { cx: 120, cy: 120, r: 38, class: 'm3' }),
        ]);
        cover.append(
            mark,
            el('div', { class: 'cover-text' }, [
                el('h1', { id: 'atlas-title', class: 'cover-title' }, [t('app.title')]),
                el('p', { class: 'cover-sub' }, [t('cover.lead')]),
                el('div', { class: 'cover-progress' }, [
                    el('span', { class: 'progress-bar', style: `--p:${total ? done / total : 0}` }),
                    el('span', {}, [t('cover.progress', { done, total })]),
                ]),
                el('a', { class: 'btn btn-primary cover-continue', href: ctx.continueHref() }, [done ? t('cover.continue') : t('cover.start'), icon('next')]),
            ]),
        );
    }

    function renderTabs() {
        clear(tabs);
        for (const tab of TABS) {
            const selected = tab === ctx.tab();
            const b = el('button', {
                type: 'button',
                role: 'tab',
                class: `tab tab-${tab}`,
                id: `tab-${tab}`,
                'aria-selected': selected ? 'true' : 'false',
                tabindex: selected ? '0' : '-1',
                onclick: () => ctx.setTab(tab),
            }, [tab.startsWith('ch') ? el('span', { class: 'tab-num' }, [tab.slice(2)]) : null, el('span', { class: 'tab-text' }, [tabLabel(tab)])]);
            if (ctx.tabBadge(tab)) b.append(el('span', { class: 'tab-badge', 'aria-hidden': 'true' }));
            tabs.append(b);
        }
        panel.setAttribute('aria-labelledby', `tab-${ctx.tab()}`);
    }

    tabs.addEventListener('keydown', e => {
        const i = TABS.indexOf(ctx.tab());
        let next = -1;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % TABS.length;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + TABS.length) % TABS.length;
        if (e.key === 'Home') next = 0;
        if (e.key === 'End') next = TABS.length - 1;
        if (next < 0) return;
        e.preventDefault();
        ctx.setTab(TABS[next]);
        requestAnimationFrame(() => { const b = tabs.querySelector(`#tab-${TABS[next]}`); if (b) b.focus(); });
    });

    async function renderChapter(chId, token) {
        const ch = chapterById(chId);
        const head = el('div', { class: 'chapter-head' }, [
            el('p', { class: 'chapter-kicker' }, [t('chapter.label', { n: chId })]),
            el('h2', { class: 'chapter-name' }, [tx(ch.name)]),
            el('p', { class: 'chapter-blurb' }, [tx(ch.blurb)]),
        ]);
        const grid = el('div', { class: 'level-grid' });
        panel.append(head, grid);
        const entries = ctx.index.main.filter(l => l.chapter === chId);
        const cards = entries.map(entry => {
            const rec = ctx.progress(entry.id);
            const locked = !ctx.isUnlocked(entry.id);
            const c = card({
                href: `#/p/${entry.id}`,
                number: String(entry.index).padStart(2, '0'),
                name: tx(entry.name),
                meta: locked ? t('level.locked') : statusLine(rec, ctx.inProgress(entry.id)) || t('level.regions', { n: entry.regions }),
                locked,
                done: rec && rec.completed,
                independent: rec && rec.independent,
                ariaLabel: `${t('level.page', { n: entry.index })} ${tx(entry.name)}. ${locked ? t('level.locked') : statusLine(rec, ctx.inProgress(entry.id))}`,
            });
            grid.append(c);
            return c;
        });
        try {
            const levels = await ctx.loadChapter(chId);
            if (token !== renderToken) return;
            levels.forEach((lv, k) => {
                const holder = cards[k].querySelector('.card-thumb');
                const ph = holder.querySelector('.thumb-placeholder');
                const rec = ctx.progress(lv.id);
                const colors = rec && rec.completed && rec.solution && rec.solution.length === lv.adj.length ? rec.solution : ctx.previewColors(lv);
                const node = thumb(lv, colors, ctx.palette(lv.chapter));
                if (ph) ph.replaceWith(node);
            });
        } catch {
            // thumbnails are decoration; the cards still work
        }
    }

    async function renderStories(token) {
        panel.append(el('div', { class: 'chapter-head' }, [
            el('h2', { class: 'chapter-name' }, [t('tabs.stories')]),
            el('p', { class: 'chapter-blurb' }, [t('story.lead')]),
        ]));
        const grid = el('div', { class: 'level-grid' });
        panel.append(grid);
        const cards = ctx.index.stories.map(entry => {
            const rec = ctx.progress(entry.id);
            const lock = ctx.storyLock(entry.id);
            const kind = entry.tags.includes('swap') ? t('story.kindSwap') : t('story.kindColors');
            const c = card({
                href: `#/s/${entry.id}`,
                number: entry.id,
                name: tx(entry.name),
                meta: lock || `${kind}${rec && rec.completed ? ` · ${statusLine(rec)}` : ''}`,
                locked: Boolean(lock),
                done: rec && rec.completed,
                independent: rec && rec.independent,
                challenge: rec && rec.challenge,
                ariaLabel: `${entry.id} ${tx(entry.name)}. ${lock || kind}`,
            });
            grid.append(c);
            return c;
        });
        try {
            const levels = await ctx.loadStories();
            if (token !== renderToken) return;
            levels.forEach((lv, k) => {
                const ph = cards[k].querySelector('.thumb-placeholder');
                const rec = ctx.progress(lv.id);
                const colors = rec && rec.completed && rec.solution ? rec.solution : ctx.previewColors(lv);
                if (ph) ph.replaceWith(thumb(lv, colors, ctx.palette(lv.chapter)));
            });
        } catch { /* decoration only */ }
    }

    function renderDaily() {
        const info = ctx.dailyInfo();
        const box = el('div', { class: 'daily' });
        panel.append(el('div', { class: 'chapter-head' }, [
            el('h2', { class: 'chapter-name' }, [t('daily.title')]),
            el('p', { class: 'chapter-blurb' }, [t('daily.records', { n: info.restoredDays })]),
        ]), box);
        if (info.newDay) box.append(el('p', { class: 'notice' }, [t('daily.newDay')]));
        if (info.status.state === 'today') {
            const rec = info.todayRecord;
            box.append(el('div', { class: 'daily-card' }, [
                el('div', { class: 'daily-date' }, [icon('calendar'), el('span', {}, [t('daily.today', { date: info.today })])]),
                el('p', { class: 'daily-state' }, [rec && rec.completed ? (rec.assisted ? t('daily.doneAssisted') : t('daily.done')) : '']),
                el('a', { class: 'btn btn-primary', href: '#/daily' }, [rec && rec.completed ? t('complete.stay') : (info.todayStarted ? t('daily.continue') : t('daily.play'))]),
                el('p', { class: 'daily-next' }, [t('daily.next', { time: info.countdown })]),
            ]));
        } else if (info.status.state === 'before') {
            box.append(el('p', { class: 'notice' }, [t('daily.beforeStart', { date: info.status.startDate })]));
        } else {
            box.append(el('p', { class: 'notice' }, [t('daily.expired')]));
        }
        if (info.unfinishedOld) {
            box.append(el('a', { class: 'btn', href: `#/daily/${info.unfinishedOld.date}` }, [t('daily.unfinished', { date: info.unfinishedOld.date })]));
        }
        if (info.status.state !== 'today' || info.showFeatured) {
            const grid = el('div', { class: 'level-grid featured' });
            box.append(el('h3', { class: 'section-title' }, [t('daily.featured')]), grid);
            for (const e of info.featured) {
                const rec = ctx.progress(e.id);
                grid.append(card({
                    href: `#/f/${e.id}`,
                    number: e.id,
                    name: e.date,
                    meta: rec && rec.completed ? statusLine(rec) : '',
                    done: rec && rec.completed,
                    independent: rec && rec.independent,
                    ariaLabel: `${e.id} ${e.date}`,
                }));
            }
        }
    }

    async function renderCollection(token) {
        panel.append(el('div', { class: 'chapter-head' }, [
            el('h2', { class: 'chapter-name' }, [t('collection.title')]),
            el('p', { class: 'chapter-blurb' }, [t('collection.lead')]),
        ]));
        const full = ctx.fullWork();
        panel.append(el('a', { class: 'full-work-card', href: '#/full' }, [
            el('span', { class: 'full-work-title' }, [icon('book'), t('collection.fullWork')]),
            el('span', { class: 'full-work-meta' }, [t('collection.fullWorkProgress', { done: full.done, total: full.total })]),
        ]));
        const items = ctx.collection();
        if (!items.length) {
            panel.append(el('p', { class: 'notice' }, [t('collection.empty')]));
            return;
        }
        const grid = el('div', { class: 'level-grid' });
        panel.append(grid);
        for (const item of items) {
            const entry = ctx.index.main.find(l => l.id === item.id) || ctx.index.stories.find(l => l.id === item.id);
            const name = entry ? tx(entry.name) : item.id;
            const date = new Date(item.savedAt).toLocaleDateString();
            const node = el('div', { class: 'level-card collection-card' }, [
                el('a', { class: 'card-thumb', href: `#/c/${item.uid}`, 'aria-label': `${t('collection.open')} ${name}` }, [el('div', { class: 'thumb-placeholder' })]),
                el('div', { class: 'card-text' }, [
                    el('span', { class: 'card-name' }, [name]),
                    el('span', { class: 'card-meta' }, [date]),
                    el('span', { class: 'card-actions' }, [
                        el('button', { type: 'button', class: 'btn btn-small', onclick: () => ctx.exportItem(item) }, [icon('download'), t('collection.export')]),
                        el('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: () => ctx.deleteItem(item) }, [icon('trash'), t('collection.delete')]),
                    ]),
                ]),
            ]);
            grid.append(node);
            ctx.loadAny(item.id).then(lv => {
                if (token !== renderToken || !lv || lv.revision !== item.revision) return;
                const ph = node.querySelector('.thumb-placeholder');
                if (ph) ph.replaceWith(thumb(lv, item.colors, ctx.palette(lv.chapter)));
            }).catch(() => {});
        }
    }

    function renderFoot() {
        clear(foot);
        foot.append(el('a', { class: 'games-link', href: 'https://games.orangely.xyz/', rel: 'noopener' }, [icon('back'), t('nav.games')]));
    }

    return {
        element: root,
        render() {
            const token = ++renderToken;
            root.dataset.tab = ctx.tab();
            renderCover();
            renderTabs();
            clear(panel);
            const tab = ctx.tab();
            if (tab.startsWith('ch')) renderChapter(Number(tab.slice(2)), token);
            else if (tab === 'stories') renderStories(token);
            else if (tab === 'daily') renderDaily();
            else if (tab === 'collection') renderCollection(token);
            renderFoot();
        },
    };
}

export { CHAPTERS };
