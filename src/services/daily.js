// Daily map dates use one clock for everyone: UTC+8. A daily session locks the
// date and content revision it was opened with, so a page started before
// midnight is still finished as the same puzzle afterwards.

const DAY = 24 * 3600 * 1000;
const OFFSET = 8 * 3600 * 1000;

/** UTC+8 calendar date as YYYY-MM-DD. */
export function utc8Date(now = Date.now()) {
    const d = new Date(now + OFFSET);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Milliseconds until the next UTC+8 midnight. */
export function msUntilNextDay(now = Date.now()) {
    const shifted = now + OFFSET;
    return DAY - (((shifted % DAY) + DAY) % DAY);
}

export function formatCountdown(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    return `${h}:${String(m).padStart(2, '0')}`;
}

/**
 * Where today stands in the manifest.
 * state: 'today' (entry for this date), 'before' (bank not started), 'expired' (bank used up)
 */
export function dailyStatus(manifest, date) {
    const entries = manifest.entries;
    if (!entries.length) return { state: 'expired', entry: null };
    const entry = entries.find(e => e.date === date) || null;
    if (entry) return { state: 'today', entry };
    if (date < entries[0].date) return { state: 'before', entry: null, startDate: entries[0].date };
    return { state: 'expired', entry: null };
}

export function featuredEntries(manifest) {
    return manifest.featured.map(id => manifest.entries.find(e => e.id === id)).filter(Boolean);
}

/** Session to resume for the daily tab: the locked one if it is unfinished, else today's. */
export function dailySessionPlan(snapshotDaily, manifest, today) {
    const status = dailyStatus(manifest, today);
    const locked = snapshotDaily.session;
    const lockedRecord = locked ? snapshotDaily.records[locked.date] : null;
    const unfinishedOld = locked && locked.date !== today && !(lockedRecord && lockedRecord.completed)
        ? locked : null;
    return { status, unfinishedOld, newDay: Boolean(locked && locked.date !== today) };
}

export function countRestoredDays(records) {
    return Object.values(records).filter(r => r.completed).length;
}
