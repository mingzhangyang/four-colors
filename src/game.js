// Page controller: routing between the atlas and pages, the single command
// entry (model → completion → render → save), hints, swaps, records and
// lifecycle. Rendering is always derived from committed state.

import { t, tx, setLang, getLang, colorWithPattern, listJoin } from './i18n.js';
import {
    index, manifest, loadLevel, loadChapter, loadStories, nextMainId, loadDaily, dailyEntryById,
} from './content/levels.js';
import { chapterById, paletteFor } from './content/chapters.js';
import { EMPTY, evaluate } from './model/rules.js';
import { createState, execute, restoreState, serializeState, swapCount, trimSavedHistory } from './model/commands.js';
import { previewSwap } from './model/kempe.js';
import { createMap } from './render/map.js';
import { createAtlasView, thumb } from './render/atlas.js';
import { createToasts, createAnnouncer, setText } from './render/feedback.js';
import { el, clear, icon } from './render/dom.js';
import { attachPointer } from './input/pointer.js';
import { attachKeyboard, spatialNext } from './input/keyboard.js';
import {
    utc8Date, msUntilNextDay, formatCountdown, dailyStatus, dailySessionPlan, countRestoredDays, archiveEntries, isReleased,
} from './services/daily.js';
import { renderPage, renderMosaic, downloadCanvas, stampPattern } from './services/export.js';
import { sessionKey, MAX_SESSIONS, MAX_COLLECTION, MAX_IDLE_HISTORY, MAX_SAVED_HISTORY } from './storage.js';
import { createAnalytics } from './services/analytics.js';

const GAMES_URL = 'https://games.orangely.xyz/';
const SITE_URL = 'https://four-colors.orangely.xyz/';
const SAVE_DELAY = 220;

export function createGame({ root, storage, saves, settings, hints, audio, now = () => Date.now(), tabId }) {
    let snap = saves.load();
    const toasts = createToasts(document.body);
    const announcer = createAnnouncer(document.body);
    let view = null; // 'atlas' | 'play' | 'full' | 'error'
    let atlasTab = snap.lastTab || 'ch1';
    let play = null;
    let saveTimer = null;
    let saveFailedShown = false;
    let sessionSeq = 0;
    let routeToken = 0;
    let newDayShown = false;
    let analyticsStarted = false;
    const analytics = createAnalytics('four-colors', () =>
        analyticsStarted && view === 'play' && play && play.kind !== 'collect'
        && !play.complete && !settingsDialog.open && !regionsDialog.open,
    );
    function beginAttempt() {
        if (analyticsStarted) return;
        analyticsStarted = true;
        analytics.play();
    }
    function finishAttempt() {
        if (!analyticsStarted) return;
        analytics.finish();
        analyticsStarted = false;
    }

    // ───────────────────────── shell ─────────────────────────
    const topbar = el('header', { class: 'topbar' });
    const backBtn = el('button', { type: 'button', class: 'icon-btn back-btn', onclick: () => goAtlas() }, [icon('back')]);
    const brand = el('a', { class: 'brand', href: '#/' }, [icon('book'), el('span', { class: 'brand-text' })]);
    const titleBox = el('div', { class: 'topbar-title' }, [el('span', { class: 'kicker' }), el('span', { class: 'title' })]);
    const soundBtn = el('button', { type: 'button', class: 'icon-btn sound-btn', onclick: () => toggleSound() });
    const settingsBtn = el('button', { type: 'button', class: 'icon-btn', onclick: () => openSettings() }, [icon('gear')]);
    topbar.append(el('div', { class: 'topbar-left' }, [backBtn, brand]), titleBox, el('div', { class: 'topbar-right' }, [soundBtn, settingsBtn]));
    const main = el('main', { class: 'view', id: 'view' });
    clear(root);
    root.append(topbar, main);
    root.removeAttribute('aria-busy');

    const settingsDialog = el('dialog', { class: 'sheet settings-sheet', 'aria-labelledby': 'settings-title' });
    const regionsDialog = el('dialog', { class: 'sheet regions-sheet', 'aria-labelledby': 'regions-title' });
    document.body.append(settingsDialog, regionsDialog);

    const atlas = createAtlasView({
        index,
        tab: () => atlasTab,
        setTab: tab => { location.hash = `#/atlas/${tab}`; },
        tabBadge: tab => tab === 'daily' && dailyBadge(),
        mainDoneCount: () => index.main.filter(e => isDone(e.id)).length,
        mainTotal: () => index.main.length,
        continueHref: () => continueHref(),
        progress: id => snap.progress[id] || null,
        isUnlocked: id => isUnlocked(id),
        inProgress: id => Object.keys(snap.sessions).some(k => k.startsWith(`${id}@`) && snap.sessions[k].colors.some(c => c !== EMPTY)),
        storyLock: id => storyLock(id),
        loadChapter,
        loadStories,
        loadAny: id => loadArtworkLevel(id),
        palette: ch => paletteFor(ch, settings.get('skin')),
        previewColors: lv => previewColorsFor(lv),
        dailyInfo: () => dailyInfo(),
        collection: () => snap.collection,
        exportItem: item => exportCollectionItem(item),
        deleteItem: item => deleteCollectionItem(item),
        fullWork: () => ({ done: index.main.filter(e => isDone(e.id)).length, total: index.main.length }),
    });

    // ───────────────────────── play view ─────────────────────────
    const map = createMap();
    const playEl = el('section', { class: 'play' });
    const pageEl = el('div', { class: 'page' });
    const legend = el('p', { class: 'legend' });
    const sealEl = el('div', { class: 'page-seal', 'aria-hidden': 'true' }, [el('span')]);
    const mapHost = el('div', {
        class: 'map-host',
        tabindex: '0',
        role: 'application',
        'aria-describedby': 'status',
    }, [map.element]);
    pageEl.append(legend, mapHost, sealEl);
    const statusEl = el('p', { class: 'status', id: 'status', role: 'status', 'aria-live': 'polite' });
    const palette = el('div', { class: 'palette', role: 'group' });
    const paintBtns = [0, 1, 2, 3].map(c => el('button', {
        type: 'button', class: 'paint', 'data-c': c, 'aria-pressed': 'false', onclick: () => onPalette(c),
    }, [el('span', { class: 'swatch', 'data-c': c }), el('span', { class: 'paint-key', 'aria-hidden': 'true' }, [String(c + 1)])]));
    palette.append(...paintBtns);
    const undoBtn = el('button', { type: 'button', class: 'icon-btn dock-btn', onclick: () => commit({ type: 'undo' }) }, [icon('undo')]);
    const moreBtn = el('button', { type: 'button', class: 'icon-btn dock-btn', 'aria-expanded': 'false', onclick: () => toggleTray() }, [icon('more')]);
    const tray = el('div', { class: 'tray', hidden: true });
    const trayBtn = (name, ic, fn) => el('button', { type: 'button', class: `tray-btn tray-${name}`, onclick: fn }, [icon(ic), el('span', { class: 'tray-label' })]);
    const tEraseBtn = trayBtn('erase', 'erase', () => selectTool(play.state.tool === 'erase' ? 'paint' : 'erase'));
    const tSwapBtn = trayBtn('swap', 'swap', () => selectTool(play.state.tool === 'swap' ? 'paint' : 'swap'));
    const tRedoBtn = trayBtn('redo', 'redo', () => commit({ type: 'redo' }));
    const tHintBtn = trayBtn('hint', 'hint', () => requestHint());
    const tViewBtn = trayBtn('views', 'flip', () => flipView());
    const tListBtn = trayBtn('regions', 'list', () => openRegionList());
    const tRestartBtn = trayBtn('restart', 'restart', () => commit({ type: 'restart' }));
    tray.append(tEraseBtn, tSwapBtn, tRedoBtn, tHintBtn, tViewBtn, tListBtn, tRestartBtn);
    const swapBar = el('div', { class: 'action-bar swap-bar', hidden: true });
    const swapText = el('span', { class: 'bar-text' });
    const swapConfirm = el('button', { type: 'button', class: 'btn btn-primary', onclick: () => confirmSwap() });
    const swapCancel = el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => cancelPreview() });
    swapBar.append(swapText, swapCancel, swapConfirm);
    const completeBar = el('div', { class: 'action-bar complete-bar', hidden: true });
    const collectBar = el('div', { class: 'action-bar collect-bar', hidden: true });
    const dockMain = el('div', { class: 'dock-main' }, [palette, el('div', { class: 'dock-actions' }, [undoBtn, moreBtn])]);
    const dock = el('div', { class: 'dock' }, [tray, swapBar, completeBar, collectBar, dockMain]);
    playEl.append(pageEl, el('div', { class: 'side' }, [statusEl, dock]));

    const pointer = attachPointer(map.element, {
        regionAt: (x, y) => map.regionAt(x, y),
        toMap: (x, y) => map.toMap(x, y),
        onTap: (i, p) => onRegion(i, p),
        onLongPress: i => showRegionInfo(i),
    });
    map.element.addEventListener('click', e => {
        const b = e.target.closest('[data-region-button]');
        if (b && e.detail === 0) onRegion(Number(b.getAttribute('data-i')), null);
    });
    attachKeyboard(mapHost, {
        move: key => moveFocus(key),
        color: c => onPalette(c),
        apply: () => { if (play && play.focus >= 0) onRegion(play.focus, null, { keyboard: true }); },
        erase: () => { if (play && play.focus >= 0 && allowed('erase')) commit({ type: 'erase', region: play.focus }); },
        undo: () => commit({ type: 'undo' }),
        redo: () => commit({ type: 'redo' }),
        hint: () => requestHint(),
        swapTool: () => { if (allowed('swap')) selectTool(play.state.tool === 'swap' && !swapOnly() ? 'paint' : 'swap'); },
        regionList: () => openRegionList(),
        escape: () => {
            if (play && play.preview) { cancelPreview(); return true; }
            if (!tray.hidden) { toggleTray(false); return true; }
            return false;
        },
    });
    // number keys and undo also work while focus sits on the dock
    playEl.addEventListener('keydown', e => {
        if (e.target === mapHost || e.target.closest('input, select, textarea, dialog')) return;
        if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key >= '1' && e.key <= '4') { onPalette(Number(e.key) - 1); e.preventDefault(); }
        if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) { commit({ type: e.shiftKey ? 'redo' : 'undo' }); e.preventDefault(); }
    });
    // any tap during the completion reveal finishes it at once
    pageEl.addEventListener('pointerdown', () => pageEl.classList.add('reveal-now'));

    // ───────────────────────── helpers ─────────────────────────
    function isDone(id) {
        const r = snap.progress[id];
        return Boolean(r && r.completed);
    }

    function mainIndex(id) {
        return index.main.findIndex(e => e.id === id);
    }

    function isUnlocked(id) {
        const i = mainIndex(id);
        if (i < 0) return !storyLock(id);
        const done = index.main.filter(e => isDone(e.id)).length;
        return i < done + 3 || isDone(id);
    }

    function storyLock(id) {
        const entry = index.stories.find(e => e.id === id);
        if (!entry) return null;
        if (entry.tags.includes('swap')) return isDone('FC26') ? null : t('story.lockSwap');
        return isDone('FC08') ? null : t('story.lockColors');
    }

    function swapUnlocked() {
        return isDone('FC25') || isDone('FC26');
    }

    function continueHref() {
        const cur = snap.current;
        if (cur && (cur.kind === 'main' || cur.kind === 'story')) {
            const rec = snap.progress[cur.id];
            if (!rec || !rec.completed) return cur.kind === 'main' ? `#/p/${cur.id}` : `#/s/${cur.id}`;
        }
        const next = index.main.find(e => !isDone(e.id));
        return next ? `#/p/${next.id}` : '#/full';
    }

    function previewColorsFor(lv) {
        const s = snap.sessions[sessionKey(lv.id, lv.revision)];
        if (s && Array.isArray(s.colors) && s.colors.length === lv.adj.length) return s.colors;
        return lv.fixed.map((c, i) => (c !== EMPTY ? c : lv.initial ? lv.initial[i] : EMPTY));
    }

    function regionName(i) {
        return play ? play.level.ids[i] : String(i);
    }

    function fmtParam(v) {
        if (v && typeof v === 'object') {
            if ('r' in v) return regionName(v.r);
            if ('c' in v) return colorWithPattern(v.c);
            if ('cs' in v) return listJoin(v.cs.map(c => colorWithPattern(c)));
        }
        return v;
    }

    function hintText(h) {
        if (!h) return '';
        const params = {};
        for (const [k, v] of Object.entries(h.params || {})) params[k] = fmtParam(v);
        return t(h.key, params);
    }

    function swapOnly() {
        return play && play.puzzle.actions.length === 1 && play.puzzle.actions[0] === 'swap';
    }

    function allowed(action) {
        return Boolean(play && play.puzzle.actions.includes(action));
    }

    function dailyBadge() {
        const st = dailyStatus(manifest, utc8Date(now()));
        if (st.state !== 'today') return false;
        const rec = snap.daily.records[st.entry.id];
        return !(rec && rec.completed);
    }

    function dailyInfo() {
        const today = utc8Date(now());
        const plan = dailySessionPlan(snap.daily, manifest, today);
        const todayRecord = plan.status.entry ? snap.daily.records[plan.status.entry.id] || null : null;
        const todayStarted = Boolean(plan.status.entry && Object.keys(snap.sessions).some(k => k.startsWith(`${plan.status.entry.id}@`)));
        return {
            today,
            status: plan.status,
            todayRecord,
            todayStarted,
            unfinishedOld: plan.unfinishedOld,
            newDay: plan.newDay && !(todayRecord && todayRecord.completed) && !todayStarted,
            restoredDays: countRestoredDays(snap.daily.records),
            countdown: formatCountdown(msUntilNextDay(now())),
            archive: archiveEntries(manifest, today).map(e => ({ ...e, record: snap.daily.records[e.id] || null })),
            total: manifest.entries.length,
        };
    }

    // ───────────────────────── saving ─────────────────────────
    function persistSession() {
        if (!play || play.kind === 'collect') return;
        const key = sessionKey(play.level.id, play.level.revision);
        snap.sessions[key] = { ...serializeState(play.state, MAX_SAVED_HISTORY), touchedAt: now() };
        const keys = Object.keys(snap.sessions).sort((a, b) => (snap.sessions[b].touchedAt || 0) - (snap.sessions[a].touchedAt || 0));
        keys.forEach((k, i) => {
            if (i >= MAX_SESSIONS) delete snap.sessions[k];
            else if (k !== key) snap.sessions[k] = trimSavedHistory(snap.sessions[k], MAX_IDLE_HISTORY);
        });
    }

    function scheduleSave() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(flushSave, SAVE_DELAY);
    }

    function flushSave({ force = false } = {}) {
        clearTimeout(saveTimer);
        saveTimer = null;
        persistSession();
        const res = saves.save(snap, { force });
        if (res.ok) {
            saveFailedShown = false;
            toasts.dismiss('save');
            return true;
        }
        if (res.reason === 'conflict') showConflict();
        else if (!saveFailedShown) {
            saveFailedShown = true;
            toasts.show('save', t('toast.saveFailed'), { timeout: 7000 });
        }
        return false;
    }

    function showConflict() {
        if (toasts.has('conflict')) return;
        toasts.show('conflict', t('toast.conflict'), {
            actions: [
                { label: t('toast.conflictLoad'), primary: true, run: () => {
                    // Discard the old session before adopting the other tab's snapshot.
                    // Ordinary navigation flushes pending edits; replacement must not.
                    clearTimeout(saveTimer);
                    saveTimer = null;
                    leavePlay();
                    snap = saves.load();
                    route(true);
                } },
                { label: t('toast.conflictKeep'), run: () => flushSave({ force: true }) },
            ],
        });
    }

    window.addEventListener('storage', e => {
        if (e.key === storage.key('save') && saves.hasConflict()) showConflict();
    });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            if (saveTimer || play) flushSave();
            audio.suspend();
            pointer.cancel();
        }
    });
    window.addEventListener('pagehide', () => { if (saveTimer) flushSave(); });

    // ───────────────────────── settings ─────────────────────────
    function applyTheme() {
        const theme = settings.resolvedTheme();
        document.documentElement.dataset.theme = theme;
        // browser chrome follows the page theme, not only the system scheme
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute('content', theme === 'dark' ? '#1b1c1e' : '#f4ecdd');
    }

    function applySettings() {
        setLang(settings.get('lang'));
        applyTheme();
        document.documentElement.dataset.skin = settings.get('skin');
        document.documentElement.classList.toggle('reduce-motion', settings.reducedMotion());
        document.documentElement.classList.toggle('motion-full', settings.get('motion') === 'full');
        refreshChrome();
    }

    settings.onChange(key => {
        if (key === 'lang') {
            setLang(settings.get('lang'));
            refreshChrome();
            if (view === 'atlas') atlas.render();
            if (view === 'play') { refreshPlayLabels(); renderPlay(); }
            if (view === 'full') openFull();
        }
        if (key === 'theme') applyTheme();
        if (key === 'motion') {
            document.documentElement.classList.toggle('reduce-motion', settings.reducedMotion());
            document.documentElement.classList.toggle('motion-full', settings.get('motion') === 'full');
            map.setOptions({ reducedMotion: settings.reducedMotion() });
        }
        if (key === 'skin') {
            document.documentElement.dataset.skin = settings.get('skin');
            if (play) applyPalette();
            if (view === 'atlas') atlas.render();
        }
        if (key === 'texture' || key === 'labels') {
            map.setOptions({ texture: settings.get('texture'), labels: settings.get('labels') });
        }
        if (key === 'muted') refreshChrome();
        if (!settings.lastWriteOk && !saveFailedShown) {
            saveFailedShown = true;
            toasts.show('save', t('toast.saveFailed'), { timeout: 7000 });
        }
    });

    function toggleSound() {
        const next = !settings.get('muted');
        settings.set('muted', next);
        audio.setMuted(next); // inside the click gesture: unlocks audio when enabling
        if (!next) audio.play('stamp');
    }

    function refreshChrome() {
        brand.querySelector('.brand-text').textContent = t('app.title');
        backBtn.setAttribute('aria-label', t('nav.back'));
        backBtn.title = t('nav.back');
        settingsBtn.setAttribute('aria-label', t('nav.settings'));
        settingsBtn.title = t('nav.settings');
        const muted = settings.get('muted');
        clear(soundBtn);
        soundBtn.append(icon(muted ? 'soundOff' : 'soundOn'));
        soundBtn.setAttribute('aria-label', muted ? t('nav.soundOff') : t('nav.soundOn'));
        soundBtn.setAttribute('aria-pressed', muted ? 'false' : 'true');
        soundBtn.title = muted ? t('nav.soundOff') : t('nav.soundOn');
        document.title = view === 'play' && play ? `${pageTitle()} · ${t('app.title')}` : `${t('app.title')} · Fourfold Atlas`;
    }

    function openSettings() {
        clear(settingsDialog);
        const s = settings.all();
        const radio = (name, value, label, current) => el('label', { class: 'choice' }, [
            el('input', { type: 'radio', name, value, checked: current === value ? true : null, onchange: () => settings.set(name, value) }),
            el('span', {}, [label]),
        ]);
        const check = (name, label) => el('label', { class: 'switch' }, [
            el('input', { type: 'checkbox', checked: s[name] ? true : null, onchange: e => settings.set(name, e.target.checked) }),
            el('span', {}, [label]),
        ]);
        const sound = el('label', { class: 'switch' }, [
            el('input', {
                type: 'checkbox',
                checked: s.muted ? null : true,
                onchange: e => { settings.set('muted', !e.target.checked); audio.setMuted(!e.target.checked); if (e.target.checked) audio.play('stamp'); },
            }),
            el('span', {}, [t('settings.sound')]),
        ]);
        settingsDialog.append(
            el('form', { method: 'dialog', class: 'sheet-body' }, [
                el('h2', { id: 'settings-title', class: 'sheet-title' }, [t('settings.title')]),
                el('fieldset', {}, [el('legend', {}, [t('settings.language')]), radio('lang', 'zh', '中文', s.lang), radio('lang', 'en', 'English', s.lang)]),
                el('fieldset', {}, [el('legend', {}, [t('settings.theme')]),
                    radio('theme', 'light', t('settings.themeLight'), s.theme), radio('theme', 'dark', t('settings.themeDark'), s.theme), radio('theme', 'system', t('settings.themeSystem'), s.theme)]),
                el('fieldset', {}, [el('legend', {}, [t('settings.skin')]),
                    radio('skin', 'atlas', t('settings.skinAtlas'), s.skin), radio('skin', 'mist', t('settings.skinMist'), s.skin), radio('skin', 'contrast', t('settings.skinContrast'), s.skin)]),
                el('fieldset', {}, [el('legend', {}, [t('settings.motion')]),
                    radio('motion', 'system', t('settings.motionSystem'), s.motion), radio('motion', 'reduced', t('settings.motionReduced'), s.motion), radio('motion', 'full', t('settings.motionFull'), s.motion)]),
                el('div', { class: 'switches' }, [sound, el('p', { class: 'fine' }, [t('settings.soundHint')]), check('texture', t('settings.texture')), check('labels', t('settings.labels'))]),
                el('p', { class: 'sheet-links' }, [el('a', { href: GAMES_URL, rel: 'noopener' }, [t('nav.games')])]),
                el('div', { class: 'sheet-actions' }, [el('button', { class: 'btn btn-primary', value: 'close' }, [t('settings.close')])]),
            ]),
        );
        settingsDialog.showModal();
    }
    settingsDialog.addEventListener('close', () => { if (view === 'atlas') atlas.render(); });

    // ───────────────────────── routing ─────────────────────────
    function parseHash() {
        const h = location.hash.replace(/^#\/?/, '');
        const [a, b] = h.split('/');
        if (!a) return { name: 'atlas' };
        if (a === 'atlas') return { name: 'atlas', tab: b };
        if (a === 'p' && b) return { name: 'play', kind: 'main', id: b.toUpperCase() };
        if (a === 's' && b) return { name: 'play', kind: 'story', id: b.toUpperCase() };
        if (a === 'daily') return { name: 'play', kind: 'daily', no: b ? Number(b) : null };
        if (a === 'collect' && b) return { name: 'play', kind: 'collect', id: b.toUpperCase() };
        if (a === 'c' && b) return { name: 'play', kind: 'collect', uid: b };
        if (a === 'full') return { name: 'full' };
        return { name: 'atlas' };
    }

    async function route(force = false) {
        const token = ++routeToken;
        if (!snap.visited && !location.hash) {
            snap.visited = true;
            history.replaceState(null, '', '#/p/FC01');
        }
        snap.visited = true;
        const r = parseHash();
        if (r.name === 'atlas') {
            leavePlay();
            openAtlas(r.tab);
            return;
        }
        if (r.name === 'full') {
            leavePlay();
            openFull();
            return;
        }
        try {
            await openPlay(r, token, force);
        } catch (err) {
            if (token !== routeToken) return;
            showError(err);
        }
    }

    window.addEventListener('hashchange', () => route());

    function goAtlas() {
        const tab = play ? (play.kind === 'story' ? 'stories' : play.kind === 'daily' ? 'daily'
            : play.kind === 'collect' ? 'collection' : `ch${play.level.chapter}`) : atlasTab;
        location.hash = `#/atlas/${tab}`;
    }

    function setView(name) {
        view = name;
        root.dataset.view = name;
        topbar.dataset.view = name;
    }

    function openAtlas(tab) {
        const valid = ['ch1', 'ch2', 'ch3', 'ch4', 'stories', 'daily', 'collection'];
        if (valid.includes(tab)) atlasTab = tab;
        snap.lastTab = atlasTab;
        setView('atlas');
        clear(main);
        main.append(atlas.element);
        setText(titleBox.querySelector('.kicker'), '');
        setText(titleBox.querySelector('.title'), '');
        atlas.render();
        refreshChrome();
        scheduleSave();
        // a new daily number is announced on return to the atlas; the daily tab shows it inline
        if (atlasTab !== 'daily' && dailyInfo().newDay && !newDayShown) {
            newDayShown = true;
            toasts.show('newday', t('daily.newDay'), { actions: [{ label: t('tabs.daily'), primary: true, run: () => { location.hash = '#/atlas/daily'; } }] });
        }
    }

    function showError(err) {
        console.error(err);
        setView('error');
        clear(main);
        main.append(el('section', { class: 'error-page' }, [
            el('h1', {}, [t('app.error')]),
            el('p', {}, [t('app.errorBody')]),
            el('p', {}, [el('a', { class: 'btn', href: '#/' }, [t('nav.home')])]),
        ]));
    }

    function leavePlay() {
        if (!play) return;
        analyticsStarted = false;
        hints.cancelAll();
        pointer.cancel();
        if (saveTimer) flushSave();
        play = null;
    }

    // ───────────────────────── opening pages ─────────────────────────
    async function loadArtworkLevel(id) {
        const daily = dailyEntryById(id);
        if (!daily) return loadLevel(id);
        if (!isReleased(manifest, utc8Date(now()), daily.no)) return null;
        return loadDaily(daily);
    }

    async function openPlay(r, token, force) {
        let level;
        const kind = r.kind;
        let collectItem = null;
        if (kind === 'main' || kind === 'story') {
            level = await loadLevel(r.id);
            if (!level || level.mode !== (kind === 'main' ? 'main' : 'story')) { location.hash = '#/'; return; }
        } else if (kind === 'daily') {
            // numbered dailies: “today” is a rule (days since the epoch + 1); the number
            // then lives in the URL, so a page opened before midnight stays the same puzzle
            const today = utc8Date(now());
            const st = dailyStatus(manifest, today);
            const no = r.no ?? (st.state === 'today' ? st.no : null);
            if (no == null || !isReleased(manifest, today, no)) { location.hash = '#/atlas/daily'; return; }
            if (r.no == null) history.replaceState(null, '', `#/daily/${no}`);
            const entry = manifest.entries.find(e => e.no === no);
            try {
                level = await loadDaily(entry);
            } catch {
                if (token !== routeToken) return;
                // retry returns to this numbered daily, which issues a fresh request
                toasts.show('daily', t('daily.loadFailed'), { actions: [{ label: t('daily.retry'), primary: true, run: () => { location.hash = `#/daily/${no}`; } }] });
                location.hash = '#/atlas/daily';
                return;
            }
            snap.daily.session = { date: today, no, id: entry.id, revision: entry.revision };
        } else if (kind === 'collect') {
            if (r.uid) {
                collectItem = snap.collection.find(c => c.uid === r.uid);
                if (!collectItem) { location.hash = '#/atlas/collection'; return; }
                level = await loadArtworkLevel(collectItem.id) || null;
                if (!level || level.revision !== collectItem.revision) { location.hash = '#/atlas/collection'; return; }
            } else {
                level = await loadArtworkLevel(r.id);
                if (!level || !isDone(level.id)) {
                    location.hash = !level ? '#/' : level.mode === 'daily' ? `#/daily/${level.no}`
                        : level.mode === 'story' ? `#/s/${level.id}` : `#/p/${level.id}`;
                    return;
                }
            }
        }
        if (token !== routeToken) return;
        if (!force && play && play.level.id === level.id && play.kind === kind && !collectItem) return;
        leavePlay();
        mountPlay({ level, kind, collectItem });
    }

    function puzzleFor(level, kind, collectColors) {
        if (kind === 'collect') {
            return { id: level.id, revision: level.revision, adj: level.adj, fixed: level.adj.map(() => EMPTY), initial: collectColors, actions: ['fill', 'erase'], goals: {} };
        }
        let actions = level.actions;
        if (level.mode === 'daily' && !swapUnlocked()) actions = actions.filter(a => a !== 'swap');
        return { ...level, actions };
    }

    function mountPlay({ level, kind, collectItem }) {
        analyticsStarted = false;
        let colorsSeed = null;
        if (kind === 'collect') {
            const rec = snap.progress[level.id];
            colorsSeed = collectItem ? collectItem.colors.slice()
                : (play && play.level.id === level.id ? play.state.colors.slice()
                    : (rec && rec.solution && rec.solutionRevision === level.revision ? rec.solution.slice() : level.witness.slice()));
        }
        const puzzle = puzzleFor(level, kind, colorsSeed);
        let state = null;
        if (kind !== 'collect') {
            const key = sessionKey(level.id, level.revision);
            state = restoreState(puzzle, snap.sessions[key]);
            // states saved for an older revision are dropped, records are kept
            const stale = Object.keys(snap.sessions).filter(k => k.startsWith(`${level.id}@`) && k !== key);
            if (stale.length) {
                stale.forEach(k => delete snap.sessions[k]);
                toasts.show('revision', t('toast.revisionChanged'), { timeout: 6000 });
            }
            if (snap.sessions[key] && !state) delete snap.sessions[key];
        }
        if (!state) {
            state = createState(puzzle);
            if (swapOnlyPuzzle(puzzle)) state.tool = 'swap';
            else if (!(level.id === 'FC01' && !isDone('FC01'))) state.color = 0;
        }
        if (swapOnlyPuzzle(puzzle)) state.tool = 'swap';
        if (state.truncated) toasts.show('history', t('toast.historyTrimmed', { n: state.undo.length }), { timeout: 5000 });
        play = {
            level,
            puzzle,
            kind,
            state,
            sessionId: ++sessionSeq,
            collectUid: collectItem ? collectItem.uid : null,
            collectTexture: collectItem ? collectItem.texture : settings.get('texture'),
            eval: null,
            complete: false,
            preview: null,
            previewRegion: -1,
            hint: null,
            hintLayer: 0,
            hintRevision: -1,
            hintPending: false,
            focus: -1,
            override: null,
            pulse: false,
        };
        play.eval = evaluate(puzzle, state.colors);
        play.complete = kind !== 'collect' && play.eval.complete;
        snap.current = { kind, id: level.id, revision: level.revision };
        if (collectItem) snap.current.uid = collectItem.uid;
        setView('play');
        clear(main);
        main.append(playEl);
        playEl.dataset.kind = kind;
        playEl.dataset.chapter = level.chapter;
        playEl.classList.toggle('swap-only', swapOnlyPuzzle(puzzle));
        pageEl.classList.remove('reveal-now', 'celebrate');
        applyPalette();
        map.mount(level, {
            texture: kind === 'collect' ? play.collectTexture : settings.get('texture'),
            labels: settings.get('labels'),
            reducedMotion: settings.reducedMotion(),
        });
        map.revealArt(play.complete || play.kind === 'collect');
        refreshPlayLabels();
        toggleTray(false);
        renderPlay();
        refreshChrome();
        scheduleSave();
        requestAnimationFrame(() => map.layoutLabelButtons());
    }

    function swapOnlyPuzzle(p) {
        return p.actions.length === 1 && p.actions[0] === 'swap';
    }

    function applyPalette() {
        const pal = paletteFor(play.level.chapter, settings.get('skin'));
        pal.forEach((c, i) => playEl.style.setProperty(`--c${i}`, c));
    }

    function pageTitle() {
        if (!play) return '';
        const lv = play.level;
        if (lv.mode === 'daily') return t('daily.number', { no: lv.no });
        return tx(lv.name);
    }

    function refreshPlayLabels() {
        if (!play) return;
        const lv = play.level;
        const kicker = lv.mode === 'main' ? `${tx(chapterById(lv.chapter).name)} · ${String(lv.index).padStart(2, '0')}`
            : lv.mode === 'story' ? `${t('tabs.stories')} · ${lv.id}` : t('daily.title');
        setText(titleBox.querySelector('.kicker'), kicker);
        setText(titleBox.querySelector('.title'), pageTitle());
        mapHost.setAttribute('aria-label', `${pageTitle()}. ${t('a11y.map')}`);
        palette.setAttribute('aria-label', t('tool.palette'));
        paintBtns.forEach((b, c) => {
            b.setAttribute('aria-label', colorWithPattern(c));
            b.title = `${colorWithPattern(c)} (${c + 1})`;
        });
        undoBtn.setAttribute('aria-label', t('tool.undo'));
        undoBtn.title = t('tool.undo');
        moreBtn.setAttribute('aria-label', t('tool.more'));
        moreBtn.title = t('tool.more');
        const labels = [[tEraseBtn, 'tool.erase'], [tSwapBtn, 'tool.swap'], [tRedoBtn, 'tool.redo'], [tHintBtn, 'tool.hint'],
            [tViewBtn, 'tool.views'], [tListBtn, 'tool.regions'], [tRestartBtn, 'tool.restart']];
        for (const [b, k] of labels) b.querySelector('.tray-label').textContent = t(k);
        swapConfirm.textContent = t('swap.confirm');
        swapCancel.textContent = t('swap.cancel');
        const notes = [];
        if (lv.note && play.kind !== 'collect') notes.push(tx(lv.note));
        if (lv.water) notes.push(t('status.water'));
        legend.textContent = notes.join(' ');
        legend.hidden = notes.length === 0;
        updateSeal();
    }

    /** Eight collection seals: one per chapter, stories, challenge, daily and the full atlas. */
    function sealKind() {
        const lv = play.level;
        if (lv.mode === 'daily') return 'daily';
        if (lv.mode === 'story') {
            const rec = snap.progress[lv.id];
            return rec && rec.challenge ? 'challenge' : 'story';
        }
        return `ch${lv.chapter}`;
    }

    function updateSeal() {
        if (!play) return;
        const kind = sealKind();
        sealEl.dataset.kind = kind;
        sealEl.querySelector('span').textContent = t(`seal.${kind}`);
        sealEl.setAttribute('title', t('complete.stamp'));
    }

    // ───────────────────────── rendering ─────────────────────────
    function statusText() {
        const p = play;
        const ev = p.eval;
        if (p.override) return p.override;
        if (p.hintPending) return t('hint.thinking');
        if (p.hint && p.hintRevision === p.state.stateRevision) return hintText(p.hint);
        if (p.kind === 'collect') return t('status.collect');
        if (p.state.tool === 'swap') {
            if (ev.conflictCount) return t('swap.conflicts');
            if (p.preview) {
                if (!p.preview.ok) return t(p.preview.reason === 'locked' ? 'swap.locked' : 'swap.conflicts');
                return p.preview.regions.length === 1 ? t('swap.previewOne') : t('swap.preview', { n: p.preview.regions.length });
            }
            const pair = p.state.pair || [];
            if (pair.length < 2 && !p.complete) return pair.length ? t('swap.pickSecond') : t('swap.pick');
        }
        if (p.complete) {
            const parts = [t('status.complete')];
            const rec = snap.progress[p.level.id];
            if (p.level.goals.optimalSwaps) parts.push(t('status.swapsUsed', { n: swapCount(p.state), best: p.level.goals.optimalSwaps }));
            if (rec && rec.independent && p.state.hintsUsed === 0) parts.push(t('level.independent'));
            return parts.join(' · ');
        }
        if (ev.conflictCount) return ev.empty ? t('status.conflicts', { n: ev.conflictCount }) : t('status.conflictsAll', { n: ev.conflictCount });
        if (!ev.maxColorsOk) return t('status.tooManyColors', { used: ev.colorsUsed, max: ev.maxColors });
        const parts = [];
        if (ev.targetsTotal) parts.push(t('status.targets', { met: ev.targetsMet, total: ev.targetsTotal }));
        if (p.level.goals.optimalSwaps) parts.push(t('status.swapsUsed', { n: swapCount(p.state), best: p.level.goals.optimalSwaps }));
        if (p.state.tool === 'swap' && p.state.pair && p.state.pair.length === 2) parts.unshift(t('swap.tap', { a: colorWithPattern(p.state.pair[0]), b: colorWithPattern(p.state.pair[1]) }));
        if (parts.length) return parts.join(' · ');
        if (p.state.color === EMPTY && ev.filled === p.level.fixed.filter(c => c !== EMPTY).length) return t('status.pickColor');
        return t('status.remaining', { n: ev.empty });
    }

    function renderPlay() {
        if (!play) return;
        const p = play;
        const { state } = p;
        const tool = state.tool;
        const pair = state.pair || [];
        const swapMode = tool === 'swap';
        paintBtns.forEach((b, c) => {
            const pressed = swapMode ? pair.includes(c) : (tool === 'paint' && state.color === c);
            b.setAttribute('aria-pressed', pressed ? 'true' : 'false');
            b.classList.toggle('pair', swapMode && pair.includes(c));
            b.disabled = p.complete && swapOnly();
        });
        palette.classList.toggle('pulse', p.pulse);
        palette.dataset.tool = tool;
        undoBtn.disabled = state.undo.length === 0;
        tRedoBtn.disabled = state.redo.length === 0;
        tEraseBtn.hidden = !allowed('erase');
        tEraseBtn.setAttribute('aria-pressed', tool === 'erase' ? 'true' : 'false');
        tSwapBtn.hidden = !allowed('swap') || swapOnly();
        tSwapBtn.setAttribute('aria-pressed', swapMode ? 'true' : 'false');
        tHintBtn.hidden = p.kind === 'collect';
        tViewBtn.hidden = !p.level.views.length;
        tRestartBtn.disabled = false;

        // bars
        swapBar.hidden = !p.preview;
        if (p.preview) {
            swapText.textContent = statusText();
            swapConfirm.disabled = !p.preview.ok;
        }
        completeBar.hidden = !(p.complete && p.kind !== 'collect') || Boolean(p.preview);
        if (!completeBar.hidden && completeBar.dataset.for !== p.level.id) buildCompleteBar();
        collectBar.hidden = p.kind !== 'collect';
        if (!collectBar.hidden && !collectBar.childElementCount) buildCollectBar();
        pageEl.classList.toggle('is-complete', p.complete);
        playEl.classList.toggle('show-complete', !completeBar.hidden && !completeBar.classList.contains('stayed'));

        setText(statusEl, statusText());
        statusEl.classList.toggle('is-alert', Boolean(p.eval.conflictCount) && !p.override);
        map.render({
            colors: state.colors,
            conflicts: p.kind === 'collect' ? [] : p.eval.conflicts,
            preview: p.preview && p.preview.regions.length ? p.preview : null,
            hint: p.hint && p.hintRevision === state.stateRevision ? p.hint : null,
            focus: p.focus,
            complete: p.complete,
        });
    }

    function buildCompleteBar() {
        clear(completeBar);
        const p = play;
        completeBar.dataset.for = p.level.id;
        const stay = el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { completeBar.classList.add('stayed'); renderPlay(); mapHost.focus(); } }, [t('complete.stay')]);
        let nextHref = null;
        if (p.kind === 'main') nextHref = nextMainId(p.level.id) ? `#/p/${nextMainId(p.level.id)}` : '#/full';
        if (p.kind === 'story') {
            const i = index.stories.findIndex(e => e.id === p.level.id);
            const nxt = index.stories.slice(i + 1).find(e => !storyLock(e.id));
            nextHref = nxt ? `#/s/${nxt.id}` : '#/atlas/stories';
        }
        const next = nextHref
            ? el('a', { class: 'btn btn-primary', href: nextHref }, [t('complete.next'), icon('next')])
            : el('a', { class: 'btn btn-primary', href: '#/atlas/daily' }, [t('complete.atlas')]);
        const collect = el('a', { class: 'btn', href: `#/collect/${p.level.id}` }, [icon('palette'), t('complete.collect')]);
        const share = el('button', { type: 'button', class: 'btn', onclick: () => shareLevel() }, [icon('share'), t('complete.share')]);
        completeBar.append(stay, collect, share, next);
    }

    function buildCollectBar() {
        clear(collectBar);
        const tex = el('button', {
            type: 'button',
            class: 'btn btn-small',
            'aria-pressed': play.collectTexture ? 'true' : 'false',
            onclick: () => {
                play.collectTexture = !play.collectTexture;
                tex.setAttribute('aria-pressed', play.collectTexture ? 'true' : 'false');
                map.setOptions({ texture: play.collectTexture });
            },
        }, [t('collection.texture')]);
        collectBar.append(
            tex,
            el('button', { type: 'button', class: 'btn btn-small', onclick: () => saveCollection() }, [icon('check'), t('collection.save')]),
            el('button', { type: 'button', class: 'btn btn-small', onclick: () => exportCurrent() }, [icon('download'), t('collection.export')]),
            el('a', { class: 'btn btn-small btn-primary', href: '#/atlas/collection' }, [t('collection.done')]),
        );
    }

    // ───────────────────────── commands ─────────────────────────
    function commit(cmd, { point = null } = {}) {
        if (!play) return null;
        const p = play;
        const before = p.state;
        const res = execute(p.puzzle, before, cmd);
        if (!res.ok) {
            if (res.reason === 'fixed') { p.override = t('status.fixed'); audio.play('blocked'); }
            renderPlay();
            return res;
        }
        p.state = res.state;
        p.override = null;
        p.pulse = false;
        // a hint in flight answers a state that no longer exists: stop it now, so the
        // Worker is free and the hint button works again without waiting for the reply
        if (p.hintPending && p.state.stateRevision !== before.stateRevision) hints.cancelAll();
        if (cmd.type === 'select' || cmd.type === 'hint-used') {
            renderPlay();
            scheduleSave();
            return res;
        }
        // model first: completion judgement on committed colors
        p.preview = null;
        p.eval = evaluate(p.puzzle, p.state.colors);
        const wasComplete = p.complete;
        p.complete = p.kind !== 'collect' && p.eval.complete;
        // Only successful, meaningful puzzle edits start an attempt. Tool selections,
        // hint requests, collection recoloring and restarts never count as play.
        if (cmd.type === 'restart') analyticsStarted = false;
        else if (!wasComplete && p.kind !== 'collect' && res.changes.length) beginAttempt();
        // projections
        if (cmd.type === 'fill' && res.changes.length) {
            const [i, from, to] = res.changes[0];
            map.animateFill(i, from, to, point);
            audio.play('paint');
            announcer.say(t('a11y.filled', { region: regionName(i), color: colorWithPattern(to) }));
        } else if (cmd.type === 'erase') {
            audio.play('erase');
            announcer.say(t('a11y.erased', { region: regionName(res.changes[0][0]) }));
        } else if (cmd.type === 'swap') {
            map.animateSwap(res.changes);
            audio.play('swap');
            announcer.say(t('swap.done', { n: res.changes.length }));
        } else if (cmd.type === 'undo' || cmd.type === 'redo') {
            if (res.entry && res.entry.k === 'swap') map.animateSwap(res.changes.map(([i, b]) => [i, b]));
            announcer.say(t(cmd.type === 'undo' ? 'a11y.undo' : 'a11y.redo'));
        }
        if (p.complete && !wasComplete) {
            beginAttempt(); // handles single-step completion after restoring a partial save
            onComplete();
            finishAttempt();
        }
        if (!p.complete && wasComplete) {
            map.revealArt(false);
            pageEl.classList.remove('celebrate');
        }
        renderPlay();
        scheduleSave();
        return res;
    }

    function onPalette(c) {
        if (!play) return;
        const st = play.state;
        if (st.tool === 'swap') {
            let pair = (st.pair || []).slice();
            if (pair.includes(c)) pair = pair.filter(x => x !== c);
            else if (pair.length < 2) pair.push(c);
            else pair = [pair[0], c];
            play.preview = null;
            commit({ type: 'select', pair });
            return;
        }
        if (st.tool === 'erase' || st.color !== c || st.tool !== 'paint') {
            commit({ type: 'select', tool: 'paint', color: c });
            announcer.say(t('a11y.selected', { color: colorWithPattern(c) }));
        }
    }

    function selectTool(tool) {
        if (!play) return;
        if (swapOnly()) tool = 'swap';
        play.preview = null;
        commit({ type: 'select', tool, pair: tool === 'swap' ? play.state.pair || [] : play.state.pair });
    }

    function onRegion(i, point, { keyboard = false } = {}) {
        if (!play || i < 0) return;
        const p = play;
        // the focus ring belongs to keyboard navigation; taps leave it hidden
        p.focus = keyboard ? i : -1;
        pageEl.classList.add('reveal-now');
        const st = p.state;
        if (st.tool === 'swap') { previewAt(i); return; }
        if (st.tool === 'erase') { commit({ type: 'erase', region: i }); return; }
        if (st.color === EMPTY) {
            p.pulse = true;
            p.override = t('status.pickColor');
            renderPlay();
            return;
        }
        commit({ type: 'fill', region: i, color: st.color }, { point });
    }

    function previewAt(i) {
        const p = play;
        const pair = p.state.pair || [];
        if (pair.length < 2) {
            p.override = pair.length ? t('swap.pickSecond') : t('swap.pick');
            p.pulse = true;
            renderPlay();
            return;
        }
        const [a, b] = pair;
        const pv = previewSwap(p.puzzle, p.state.colors, i, a, b);
        if (pv.reason === 'not-in-pair' || pv.reason === 'same-colors') {
            p.preview = null;
            p.override = t('swap.notInPair', { a: colorWithPattern(a), b: colorWithPattern(b) });
            renderPlay();
            return;
        }
        if (pv.reason === 'conflicts') {
            p.preview = null;
            p.override = t('swap.conflicts');
            audio.play('blocked');
            renderPlay();
            return;
        }
        p.override = null;
        p.preview = pv;
        p.previewRegion = i;
        if (!pv.ok) audio.play('blocked');
        renderPlay();
    }

    function confirmSwap() {
        const p = play;
        if (!p || !p.preview || !p.preview.ok) return;
        const [a, b] = p.state.pair;
        commit({ type: 'swap', region: p.previewRegion, a, b });
    }

    function cancelPreview() {
        if (!play) return;
        play.preview = null;
        play.override = null;
        renderPlay();
    }

    function toggleTray(force) {
        const open = typeof force === 'boolean' ? force : tray.hidden;
        tray.hidden = !open;
        moreBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        moreBtn.classList.toggle('is-open', open);
    }

    function flipView() {
        if (!play || !play.level.views.length) return;
        const next = (map.viewIndex + 1) % (play.level.views.length + 1);
        map.setView(next);
        map.revealArt(play.complete || play.kind === 'collect');
        renderPlay();
    }

    function moveFocus(key) {
        if (!play) return;
        const points = play.level.ids.map((_, i) => map.labelPoint(i));
        const next = play.focus < 0 ? 0 : spatialNext(points, play.focus, key);
        if (next < 0) return;
        play.focus = next;
        renderPlay();
        announcer.say(describeRegion(next));
    }

    function describeRegion(i) {
        const p = play;
        const lv = p.level;
        const c = p.state.colors[i];
        const target = (lv.goals.targets || []).find(([r]) => r === i);
        const conflict = p.eval.conflicts.some(([a, b]) => a === i || b === i);
        return t('a11y.region', {
            region: lv.ids[i],
            color: colorWithPattern(c),
            fixed: lv.fixed[i] !== EMPTY ? t('a11y.fixed') : '',
            target: target ? t('a11y.target', { color: colorWithPattern(target[1]) }) : '',
            neighbours: listJoin(lv.adj[i].map(j => lv.ids[j])) || t('status.noNeighbours'),
            conflict: conflict ? t('a11y.conflict') : '',
        });
    }

    function showRegionInfo(i) {
        if (!play) return;
        const lv = play.level;
        play.focus = i;
        play.override = t('status.longPress', {
            region: lv.ids[i],
            color: colorWithPattern(play.state.colors[i]),
            neighbours: listJoin(lv.adj[i].map(j => lv.ids[j])) || t('status.noNeighbours'),
        });
        renderPlay();
    }

    function openRegionList() {
        if (!play) return;
        const p = play;
        const lv = p.level;
        clear(regionsDialog);
        const list = el('ul', { class: 'region-list' });
        lv.ids.forEach((id, i) => {
            const c = p.state.colors[i];
            const target = (lv.goals.targets || []).find(([r]) => r === i);
            const extra = [];
            if (lv.fixed[i] !== EMPTY) extra.push(t('regions.fixed'));
            if (target) extra.push(t('regions.target', { color: colorWithPattern(target[1]) }));
            const canFill = p.state.tool === 'paint' && p.state.color !== EMPTY && lv.fixed[i] === EMPTY && allowed('fill');
            list.append(el('li', { class: 'region-row' }, [
                el('span', { class: 'region-chip', 'data-c': c, style: c >= 0 ? `background:var(--c${c})` : null }),
                el('div', { class: 'region-desc' }, [
                    el('strong', {}, [t('regions.item', { region: id, color: colorWithPattern(c) })]),
                    extra.length ? el('span', { class: 'fine' }, [` · ${extra.join(' · ')}`]) : null,
                    el('div', { class: 'fine' }, [t('regions.neighbours', { list: listJoin(lv.adj[i].map(j => lv.ids[j])) || t('status.noNeighbours') })]),
                ]),
                el('div', { class: 'region-actions' }, [
                    el('button', { type: 'button', class: 'btn btn-small', onclick: () => { regionsDialog.close(); p.focus = i; renderPlay(); mapHost.focus(); announcer.say(describeRegion(i)); } }, [t('regions.select')]),
                    canFill ? el('button', { type: 'button', class: 'btn btn-small', onclick: () => { commit({ type: 'fill', region: i, color: p.state.color }); regionsDialog.close(); openRegionList(); } }, [t('regions.fill')]) : null,
                ]),
            ]));
        });
        regionsDialog.append(el('div', { class: 'sheet-body' }, [
            el('h2', { id: 'regions-title', class: 'sheet-title' }, [t('regions.title')]),
            el('p', { class: 'fine' }, [t('regions.lead')]),
            list,
            el('form', { method: 'dialog', class: 'sheet-actions' }, [el('button', { class: 'btn btn-primary' }, [t('tool.close')])]),
        ]));
        regionsDialog.style.setProperty('--c0', playEl.style.getPropertyValue('--c0'));
        for (let c = 0; c < 4; c++) regionsDialog.style.setProperty(`--c${c}`, playEl.style.getPropertyValue(`--c${c}`));
        regionsDialog.showModal();
    }

    // ───────────────────────── hints ─────────────────────────
    async function requestHint() {
        const p = play;
        if (!p || p.kind === 'collect' || p.hintPending) return;
        const sameState = p.hintRevision === p.state.stateRevision && p.hint;
        const layer = sameState ? Math.min(3, p.hintLayer + 1) : 1;
        commit({ type: 'hint-used' });
        p.hintPending = true;
        p.override = null;
        renderPlay();
        const tags = { sessionId: p.sessionId, puzzleRevision: p.level.revision, stateRevision: p.state.stateRevision };
        const reply = await hints.request({ ...tags, puzzle: p.puzzle, colors: p.state.colors, layer });
        if (play !== p) return; // page changed: drop
        p.hintPending = false;
        if (reply.cancelled) { renderPlay(); return; }
        if (reply.sessionId !== p.sessionId || reply.puzzleRevision !== p.level.revision || reply.stateRevision !== p.state.stateRevision) {
            renderPlay();
            return; // stale answer for an older state
        }
        p.hint = reply.result || { layer, key: 'hint.unavailable', params: {}, regions: [], pairs: [] };
        p.hintLayer = p.hint.layer || layer;
        p.hintRevision = p.state.stateRevision;
        if (p.hint.suggestion && p.hint.suggestion.type === 'swap' && allowed('swap')) {
            // pre-select the suggested pair so the player only needs to tap
            const { a, b } = p.hint.suggestion;
            if (p.state.tool === 'swap') commit({ type: 'select', pair: [a, b] });
        }
        renderPlay();
        announcer.say(hintText(p.hint));
    }

    // ───────────────────────── completion & records ─────────────────────────
    function onComplete() {
        const p = play;
        const lv = p.level;
        const rec = snap.progress[lv.id] || {
            revision: lv.revision, completed: false, independent: false, challenge: false, completedAt: 0,
            solution: null, solutionRevision: lv.revision, bestSwaps: null, history: [],
        };
        const first = !rec.completed;
        rec.completed = true;
        if (first) rec.completedAt = now();
        if (rec.revision !== lv.revision) {
            rec.history = [...new Set([...(rec.history || []), rec.revision])].slice(-8);
            rec.revision = lv.revision;
        }
        if (p.state.hintsUsed === 0) rec.independent = true;
        if (!rec.solution || rec.solutionRevision !== lv.revision) {
            rec.solution = p.state.colors.slice();
            rec.solutionRevision = lv.revision;
        }
        let challengeNew = false;
        if (lv.goals.optimalSwaps) {
            const used = swapCount(p.state);
            rec.bestSwaps = rec.bestSwaps == null ? used : Math.min(rec.bestSwaps, used);
            if (used <= lv.goals.optimalSwaps && lv.mode === 'story' && !rec.challenge) { rec.challenge = true; challengeNew = true; }
        } else if (lv.mode === 'story' && lv.goals.maxColors && !rec.challenge) {
            rec.challenge = true;
            challengeNew = true;
        }
        snap.progress[lv.id] = rec;
        if (p.kind === 'daily') {
            const prev = snap.daily.records[lv.id];
            snap.daily.records[lv.id] = {
                revision: lv.revision,
                completed: true,
                assisted: prev && prev.completed ? prev.assisted && p.state.hintsUsed > 0 : p.state.hintsUsed > 0,
                completedAt: prev && prev.completedAt ? prev.completedAt : now(),
            };
        }
        updateSeal();
        completeBar.dataset.for = '';
        completeBar.classList.remove('stayed');
        pageEl.classList.remove('reveal-now');
        pageEl.classList.add('celebrate');
        map.revealArt(true);
        audio.play('complete');
        announcer.say(t('status.complete'));
        if (challengeNew) toasts.show('challenge', t('complete.challenge'));
        if (lv.mode === 'main' && index.main.every(e => isDone(e.id)) && first) {
            toasts.show('finale', t('complete.finale'), { actions: [{ label: t('collection.fullWork'), primary: true, run: () => { location.hash = '#/full'; } }] });
        }
        flushSave();
    }

    // ───────────────────────── share, collection, export ─────────────────────────
    async function shareLevel() {
        const p = play;
        if (!p) return;
        const rec = snap.progress[p.level.id];
        const text = t('share.text', {
            name: pageTitle(),
            stamp: `${t('complete.stamp')} · `,
            assist: rec && rec.independent ? t('share.independent') : t('share.assisted'),
            pattern: stampPattern(p.level.id),
        });
        const url = p.kind === 'main' ? `${SITE_URL}#/p/${p.level.id}` : p.kind === 'story' ? `${SITE_URL}#/s/${p.level.id}`
            : p.kind === 'daily' ? `${SITE_URL}#/daily/${p.level.no}` : SITE_URL;
        try {
            if (navigator.share) {
                await navigator.share({ text, url });
                return;
            }
            await navigator.clipboard.writeText(`${text}\n${url}`);
            toasts.show('share', t('share.copied'));
        } catch (err) {
            if (err && err.name === 'AbortError') return;
            toasts.show('share', t('share.failed'));
        }
    }

    function saveCollection() {
        const p = play;
        if (!p || p.kind !== 'collect') return;
        if (p.collectUid) {
            const item = snap.collection.find(c => c.uid === p.collectUid);
            if (item) {
                item.colors = p.state.colors.slice();
                item.texture = p.collectTexture;
                item.savedAt = now();
                if (flushSave()) toasts.show('collect', t('collection.saved'));
                return;
            }
        }
        if (snap.collection.length >= MAX_COLLECTION) {
            toasts.show('collect', t('collection.full', { n: MAX_COLLECTION }));
            return;
        }
        const uid = `${p.level.id.toLowerCase()}-${now().toString(36)}`;
        snap.collection.unshift({ uid, id: p.level.id, revision: p.level.revision, colors: p.state.colors.slice(), texture: p.collectTexture, savedAt: now() });
        p.collectUid = uid;
        snap.current.uid = uid;
        if (flushSave()) toasts.show('collect', t('collection.saved'));
        history.replaceState(null, '', `#/c/${uid}`);
    }

    async function exportColors(level, colors, texture) {
        try {
            const canvas = renderPage(level, colors, {
                palette: paletteFor(level.chapter, settings.get('skin')),
                texture,
                contrast: settings.get('skin') === 'contrast',
                title: `${t('app.title')} · ${level.mode === 'daily' ? t('daily.number', { no: level.no }) : tx(level.name)}`,
                subtitle: level.mode === 'main' ? `${tx(chapterById(level.chapter).name)} · ${t('level.page', { n: level.index })}` : '',
                seal: isDone(level.id) ? t('complete.stamp') : '',
            });
            const ok = await downloadCanvas(canvas, `fourfold-atlas-${level.id.toLowerCase()}.png`);
            toasts.show('export', ok ? t('export.done') : t('export.failed'));
        } catch {
            toasts.show('export', t('export.failed'));
        }
    }

    function exportCurrent() {
        if (!play) return;
        exportColors(play.level, play.state.colors, play.kind === 'collect' ? play.collectTexture : settings.get('texture'));
    }

    async function exportCollectionItem(item) {
        try {
            const lv = await loadArtworkLevel(item.id);
            if (lv && lv.revision === item.revision) await exportColors(lv, item.colors, item.texture);
            else toasts.show('export', t('export.failed'));
        } catch {
            toasts.show('export', t('export.failed'));
        }
    }

    function deleteCollectionItem(item) {
        snap.collection = snap.collection.filter(c => c.uid !== item.uid);
        flushSave();
        atlas.render();
    }

    async function openFull() {
        setView('full');
        refreshChrome();
        clear(main);
        const section = el('section', { class: 'full-work' }, [
            el('h2', { class: 'chapter-name' }, [t('collection.fullWork')]),
            el('p', { class: 'chapter-blurb' }, [t('collection.fullWorkLead')]),
        ]);
        main.append(section);
        setText(titleBox.querySelector('.kicker'), t('collection.title'));
        setText(titleBox.querySelector('.title'), t('collection.fullWork'));
        const all = (await Promise.all([1, 2, 3, 4].map(ch => loadChapter(ch)))).flat();
        if (view !== 'full') return;
        const solved = lv => {
            const rec = snap.progress[lv.id];
            return rec && rec.completed && rec.solution && rec.solutionRevision === lv.revision ? rec.solution : null;
        };
        const done = all.filter(solved).length;
        section.append(el('p', { class: 'cover-progress' }, [t('collection.fullWorkProgress', { done, total: all.length })]));
        if (done === all.length) section.append(el('div', { class: 'page-seal full-seal', 'data-kind': 'full', 'aria-hidden': 'true' }, [el('span', {}, [t('seal.full')])]));
        const grid = el('div', { class: 'mosaic' });
        for (const lv of all) {
            const colors = solved(lv);
            const a = el('a', { class: `mosaic-cell${colors ? ' is-done' : ''}`, href: `#/p/${lv.id}`, 'aria-label': tx(lv.name) }, [thumb(lv, colors, paletteFor(lv.chapter, settings.get('skin')), { art: Boolean(colors) })]);
            grid.append(a);
        }
        section.append(grid, el('div', { class: 'sheet-actions' }, [
            el('button', {
                type: 'button',
                class: 'btn',
                onclick: async () => {
                    try {
                        const canvas = renderMosaic(all, solved, lv => paletteFor(lv.chapter, settings.get('skin')), { title: `${t('app.title')} · ${t('collection.fullWork')}`, contrast: settings.get('skin') === 'contrast' });
                        const ok = await downloadCanvas(canvas, 'fourfold-atlas-complete.png');
                        toasts.show('export', ok ? t('export.done') : t('export.failed'));
                    } catch {
                        toasts.show('export', t('export.failed'));
                    }
                },
            }, [icon('download'), t('collection.export')]),
            el('a', { class: 'btn btn-primary', href: '#/atlas/collection' }, [t('nav.back')]),
        ]));
    }

    // ───────────────────────── start ─────────────────────────
    applySettings();
    route();

    // test and debugging hook (no game logic depends on it)
    return {
        get play() { return play; },
        get snapshot() { return snap; },
        get view() { return view; },
        commit,
        route,
        flushSave,
        tabId,
        lang: getLang,
    };
}
