// Settings: language, theme, sound and accessibility preferences, stored in
// this game's own origin. Precedence for language and theme on first visit:
// valid stored preference > valid entry parameter (?lang=en|zh, ?theme=light|dark|system)
// > browser language / system theme. Recognised parameters are removed from
// the address bar afterwards; every other parameter and the hash stay intact.
// Sound is never taken from the URL and starts muted.

export const SETTINGS_SLOT = 'settings';

const LANGS = ['zh', 'en'];
const THEMES = ['light', 'dark', 'system'];
const SKINS = ['atlas', 'mist', 'contrast'];
const MOTIONS = ['system', 'reduced', 'full'];

export const DEFAULTS = {
    lang: null,
    theme: 'system',
    muted: true,
    skin: 'atlas',
    texture: true,
    motion: 'system',
    labels: false,
};

export function sanitizeSettings(raw) {
    const s = { ...DEFAULTS };
    if (!raw || typeof raw !== 'object') return s;
    if (LANGS.includes(raw.lang)) s.lang = raw.lang;
    if (THEMES.includes(raw.theme)) s.theme = raw.theme;
    if (typeof raw.muted === 'boolean') s.muted = raw.muted;
    if (SKINS.includes(raw.skin)) s.skin = raw.skin;
    if (typeof raw.texture === 'boolean') s.texture = raw.texture;
    if (MOTIONS.includes(raw.motion)) s.motion = raw.motion;
    if (typeof raw.labels === 'boolean') s.labels = raw.labels;
    return s;
}

/** Pure resolution of the effective language/theme (unit-tested). */
export function resolveEntry({ stored, search, browserLang, systemDark }) {
    const params = new URLSearchParams(search || '');
    const urlLang = params.get('lang');
    const urlTheme = params.get('theme');
    const consumed = [];
    if (params.has('lang')) consumed.push('lang');
    if (params.has('theme')) consumed.push('theme');
    const storedRaw = stored && typeof stored === 'object' ? stored : {};
    const lang = LANGS.includes(storedRaw.lang) ? storedRaw.lang
        : LANGS.includes(urlLang) ? urlLang
            : (String(browserLang || '').toLowerCase().startsWith('zh') ? 'zh' : 'en');
    const themePref = THEMES.includes(storedRaw.theme) ? storedRaw.theme
        : THEMES.includes(urlTheme) ? urlTheme : 'system';
    const theme = themePref === 'system' ? (systemDark ? 'dark' : 'light') : themePref;
    // only parameters that were recognised (valid or not) are stripped
    for (const k of consumed) params.delete(k);
    const rest = params.toString();
    return { lang, themePref, theme, cleanSearch: rest ? `?${rest}` : '' };
}

export function createSettings({ storage, win = globalThis.window }) {
    const stored = storage.get(SETTINGS_SLOT, null);
    // explicit preferences only: what the player chose (or chose before)
    const prefs = {};
    const clean = sanitizeSettings(stored);
    if (stored && typeof stored === 'object') {
        for (const key of Object.keys(DEFAULTS)) if (key in stored && clean[key] === stored[key]) prefs[key] = clean[key];
    }
    const mqDark = win.matchMedia ? win.matchMedia('(prefers-color-scheme: dark)') : null;
    const mqMotion = win.matchMedia ? win.matchMedia('(prefers-reduced-motion: reduce)') : null;
    const entry = resolveEntry({
        stored: prefs,
        search: win.location.search,
        browserLang: win.navigator.language,
        systemDark: Boolean(mqDark && mqDark.matches),
    });
    // entry parameters seed this session only; they are never written as preferences
    const seeded = { lang: entry.lang, theme: entry.themePref };
    if (entry.cleanSearch !== win.location.search) {
        try {
            win.history.replaceState(win.history.state, '', `${win.location.pathname}${entry.cleanSearch}${win.location.hash}`);
        } catch { /* ignore */ }
    }
    const effective = () => ({ ...DEFAULTS, ...seeded, ...prefs });
    const listeners = new Set();
    let lastWriteOk = true;

    const api = {
        get: key => effective()[key],
        all: () => effective(),
        set(key, value) {
            const next = sanitizeSettings({ ...effective(), [key]: value });
            if (next[key] === effective()[key] && prefs[key] === next[key]) return true;
            prefs[key] = next[key];
            lastWriteOk = storage.trySet(SETTINGS_SLOT, prefs);
            for (const fn of listeners) fn(key, next[key]);
            return lastWriteOk;
        },
        onChange(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
        resolvedTheme() {
            const theme = effective().theme;
            if (theme === 'system') return mqDark && mqDark.matches ? 'dark' : 'light';
            return theme;
        },
        reducedMotion() {
            const motion = effective().motion;
            if (motion === 'reduced') return true;
            if (motion === 'full') return false;
            return Boolean(mqMotion && mqMotion.matches);
        },
        get lastWriteOk() {
            return lastWriteOk;
        },
    };
    if (mqDark && mqDark.addEventListener) {
        mqDark.addEventListener('change', () => { for (const fn of listeners) fn('theme', effective().theme); });
    }
    if (mqMotion && mqMotion.addEventListener) {
        mqMotion.addEventListener('change', () => { for (const fn of listeners) fn('motion', effective().motion); });
    }
    return api;
}
