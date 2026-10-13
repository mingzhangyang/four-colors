// Runtime content loader. Chapters, stories and daily puzzles are loaded on
// demand and every compiled level is checked against its content checksum.

import index from './generated/index.js';
import manifest from './generated/daily-manifest.js';
import { verifyLevel } from './checksum.js';

export { index, manifest };

const BASE = (import.meta.env && import.meta.env.BASE_URL) || '/';

const loaders = {
    1: () => import('./generated/chapter-1.js'),
    2: () => import('./generated/chapter-2.js'),
    3: () => import('./generated/chapter-3.js'),
    4: () => import('./generated/chapter-4.js'),
    stories: () => import('./generated/stories.js'),
};

const cache = new Map();

export class ContentError extends Error {}

async function loadGroup(key) {
    if (!cache.has(key)) {
        cache.set(key, loaders[key]().then(mod => {
            const list = mod.default;
            for (const lv of list) {
                if (!verifyLevel(lv)) throw new ContentError(`checksum mismatch for ${lv.id}`);
            }
            return list;
        }).catch(err => {
            cache.delete(key);
            throw err;
        }));
    }
    return cache.get(key);
}

export function loadChapter(chapter) {
    return loadGroup(chapter);
}

export function loadStories() {
    return loadGroup('stories');
}

export function mainEntry(id) {
    return index.main.find(l => l.id === id) || null;
}

export function storyEntry(id) {
    return index.stories.find(l => l.id === id) || null;
}

export async function loadLevel(id) {
    const m = mainEntry(id);
    if (m) return (await loadChapter(m.chapter)).find(l => l.id === id);
    const s = storyEntry(id);
    if (s) return (await loadStories()).find(l => l.id === id);
    return null;
}

export function nextMainId(id) {
    const i = index.main.findIndex(l => l.id === id);
    return i >= 0 && i + 1 < index.main.length ? index.main[i + 1].id : null;
}

const dailyCache = new Map();

export function dailyEntryById(id) {
    return manifest.entries.find(e => e.id === id) || null;
}

/** Fetch one daily puzzle (lazy) and verify its revision and checksum against the manifest. */
export async function loadDaily(entry, fetchImpl = globalThis.fetch) {
    const key = `${entry.id}.r${entry.revision}`;
    if (dailyCache.has(key)) return dailyCache.get(key);
    // revision-named files are immutable and cached by HTTP headers; never force-cache,
    // or a transient error response could be replayed on retry
    const res = await fetchImpl(`${BASE}daily/${key}.json`);
    if (!res.ok) throw new ContentError(`daily ${key}: HTTP ${res.status}`);
    const level = await res.json();
    if (level.id !== entry.id || level.revision !== entry.revision || level.checksum !== entry.checksum || !verifyLevel(level)) {
        throw new ContentError(`daily ${key} failed verification`);
    }
    dailyCache.set(key, level);
    return level;
}
