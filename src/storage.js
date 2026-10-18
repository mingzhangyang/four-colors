// Versioned local storage adapter (behaviour modelled on the games
// collection's GameStorage, maintained here independently). One complete
// snapshot per write keeps progress and the current page from half-writing
// across keys; `trySet` reports whether the write actually persisted.

export const GAME_ID = 'four-colors';
export const STORAGE_VERSION = 1;
export const SNAPSHOT_SCHEMA = 1;
export const MAX_SESSIONS = 12;
export const MAX_COLLECTION = 40;
export const MAX_SAVED_HISTORY = 200;
export const MAX_IDLE_HISTORY = 40;

export function storageKey(slot, version = STORAGE_VERSION) {
    return `game:${GAME_ID}:v${version}:${slot}`;
}

function safeBackend(backend) {
    if (backend) return backend;
    try {
        return globalThis.localStorage || null;
    } catch {
        return null;
    }
}

export function createStorage({ backend = null, migrations = {} } = {}) {
    const store = safeBackend(backend);
    const rawGet = key => {
        try { return store ? store.getItem(key) : null; } catch { return null; }
    };
    const rawSet = (key, value) => {
        try {
            if (!store) return false;
            store.setItem(key, value);
            return true;
        } catch {
            return false;
        }
    };
    return {
        available: Boolean(store),
        key: storageKey,
        getRaw(slot) {
            return rawGet(storageKey(slot));
        },
        get(slot, fallback = null) {
            const raw = rawGet(storageKey(slot));
            if (raw == null) {
                // migrate forward from older versions when present
                for (let v = STORAGE_VERSION - 1; v >= 1; v--) {
                    const old = rawGet(storageKey(slot, v));
                    if (old == null) continue;
                    try {
                        let value = JSON.parse(old);
                        for (let m = v; m < STORAGE_VERSION; m++) if (migrations[m]) value = migrations[m](value, slot);
                        return value;
                    } catch {
                        return fallback;
                    }
                }
                return fallback;
            }
            try { return JSON.parse(raw); } catch { return fallback; }
        },
        trySet(slot, value) {
            let text;
            try { text = JSON.stringify(value); } catch { return false; }
            return rawSet(storageKey(slot), text);
        },
        remove(slot) {
            try { if (store) store.removeItem(storageKey(slot)); } catch { /* ignore */ }
        },
    };
}

// ───────────────────────── snapshot schema ─────────────────────────

export function emptySnapshot() {
    return {
        schema: SNAPSHOT_SCHEMA,
        writeSeq: 0,
        writer: null,
        savedAt: 0,
        visited: false,
        current: null,
        sessions: {},
        progress: {},
        daily: { session: null, records: {} },
        collection: [],
        lastTab: null,
    };
}

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const isColorArr = (a, max = 64) => Array.isArray(a) && a.length <= max && a.every(c => Number.isInteger(c) && c >= -1 && c <= 3);
const isId = v => typeof v === 'string' && /^[A-Z][A-Z0-9]{0,8}$/.test(v);
const isRev = v => Number.isInteger(v) && v >= 1 && v < 1000;

/** Write header of a stored snapshot, normalised exactly as `validateSnapshot` adopts it. */
function headerOf(raw) {
    if (!isObj(raw) || raw.schema !== SNAPSHOT_SCHEMA) return { writeSeq: 0, writer: null };
    return {
        writeSeq: Number.isInteger(raw.writeSeq) && raw.writeSeq >= 0 ? raw.writeSeq : 0,
        writer: typeof raw.writer === 'string' ? raw.writer.slice(0, 40) : null,
    };
}

export function sessionKey(id, revision) {
    return `${id}@${revision}`;
}

/**
 * Normalise anything read from storage. Malformed parts are dropped rather
 * than trusted; per-puzzle states are re-validated against their puzzle when
 * they are opened (model/commands.restoreState).
 */
export function validateSnapshot(raw) {
    const snap = emptySnapshot();
    if (!isObj(raw) || raw.schema !== SNAPSHOT_SCHEMA) return snap;
    ({ writeSeq: snap.writeSeq, writer: snap.writer } = headerOf(raw));
    snap.savedAt = Number.isFinite(raw.savedAt) ? raw.savedAt : 0;
    snap.visited = raw.visited === true;
    if (isObj(raw.current) && ['main', 'story', 'daily', 'collect'].includes(raw.current.kind)
        && isId(raw.current.id) && isRev(raw.current.revision)) {
        snap.current = { kind: raw.current.kind, id: raw.current.id, revision: raw.current.revision };
        if (raw.current.kind === 'collect' && typeof raw.current.uid === 'string') snap.current.uid = raw.current.uid.slice(0, 40);
    }
    if (isObj(raw.sessions)) {
        const entries = Object.entries(raw.sessions)
            .filter(([k, v]) => /^[A-Z][A-Z0-9]{0,8}@\d{1,3}$/.test(k) && isObj(v) && isColorArr(v.colors))
            .sort((a, b) => (b[1].touchedAt || 0) - (a[1].touchedAt || 0))
            .slice(0, MAX_SESSIONS);
        for (const [k, v] of entries) snap.sessions[k] = v;
    }
    if (isObj(raw.progress)) {
        for (const [id, p] of Object.entries(raw.progress)) {
            if (!isId(id) || !isObj(p) || !isRev(p.revision)) continue;
            snap.progress[id] = {
                revision: p.revision,
                completed: p.completed === true,
                independent: p.independent === true,
                challenge: p.challenge === true,
                completedAt: Number.isFinite(p.completedAt) ? p.completedAt : 0,
                solution: isColorArr(p.solution) ? p.solution.slice() : null,
                solutionRevision: isRev(p.solutionRevision) ? p.solutionRevision : p.revision,
                bestSwaps: Number.isInteger(p.bestSwaps) && p.bestSwaps >= 0 ? p.bestSwaps : null,
                history: Array.isArray(p.history) ? p.history.filter(isRev).slice(0, 8) : [],
            };
        }
    }
    if (isObj(raw.daily)) {
        // Resume numbered sessions from old saves; ignore the legacy calendar date.
        const s = raw.daily.session;
        if (isObj(s) && isId(s.id) && isRev(s.revision) && Number.isInteger(s.no) && s.no >= 1 && s.no < 100000) {
            snap.daily.session = { no: s.no, id: s.id, revision: s.revision };
        }
        // records are keyed by the numbered puzzle id (D001 …), never by date
        if (isObj(raw.daily.records)) {
            for (const [id, r] of Object.entries(raw.daily.records)) {
                if (!isId(id) || !isObj(r) || !isRev(r.revision)) continue;
                snap.daily.records[id] = {
                    revision: r.revision,
                    completed: r.completed === true,
                    assisted: r.assisted === true,
                    completedAt: Number.isFinite(r.completedAt) ? r.completedAt : 0,
                };
            }
        }
    }
    if (Array.isArray(raw.collection)) {
        snap.collection = raw.collection
            .filter(c => isObj(c) && typeof c.uid === 'string' && isId(c.id) && isRev(c.revision) && isColorArr(c.colors))
            .slice(0, MAX_COLLECTION)
            .map(c => ({ uid: c.uid.slice(0, 40), id: c.id, revision: c.revision, colors: c.colors.slice(), texture: c.texture !== false, savedAt: Number.isFinite(c.savedAt) ? c.savedAt : 0 }));
    }
    if (typeof raw.lastTab === 'string' && raw.lastTab.length < 20) snap.lastTab = raw.lastTab;
    return snap;
}

/**
 * Save manager with a write-version check: another tab's snapshot is never
 * silently overwritten. On conflict, `save` refuses and reports it; the caller
 * asks the player whether to load the other progress or keep this tab.
 *
 * localStorage has no compare-and-set, so two tabs can still both pass the
 * check and write moments apart. The header (writeSeq + writer) makes that
 * race visible instead of silent: whichever tab was overwritten now finds a
 * stored header it neither wrote nor loaded — even with an equal or lower
 * sequence — and reports a conflict on the `storage` event or its next save,
 * while its own progress is still in memory.
 */
export function createSaveManager({ storage, tabId, slot = 'save' }) {
    let seenSeq = 0;
    let seenWriter = null;
    return {
        load() {
            const snap = validateSnapshot(storage.get(slot, null));
            seenSeq = snap.writeSeq;
            seenWriter = snap.writer;
            return snap;
        },
        /** Peek at the stored header without adopting it. */
        peek() {
            return headerOf(storage.get(slot, null));
        },
        /** True when the stored snapshot is not the one this tab last loaded or wrote. */
        hasConflict() {
            const head = this.peek();
            if (head.writer === tabId) return false;
            return head.writeSeq !== seenSeq || head.writer !== seenWriter;
        },
        save(snapshot, { force = false } = {}) {
            if (!storage.available) return { ok: false, reason: 'unavailable' };
            if (!force && this.hasConflict()) return { ok: false, reason: 'conflict' };
            const head = this.peek();
            const next = { ...snapshot, schema: SNAPSHOT_SCHEMA, writeSeq: Math.max(head.writeSeq, seenSeq) + 1, writer: tabId, savedAt: Date.now() };
            const ok = storage.trySet(slot, next);
            if (!ok) return { ok: false, reason: 'write-failed' };
            seenSeq = next.writeSeq;
            seenWriter = tabId;
            snapshot.writeSeq = next.writeSeq;
            snapshot.writer = tabId;
            return { ok: true };
        },
        adopt(snapshot) {
            seenSeq = snapshot.writeSeq;
            seenWriter = snapshot.writer;
        },
        get seen() {
            return { seq: seenSeq, writer: seenWriter };
        },
    };
}
