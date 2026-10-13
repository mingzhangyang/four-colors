// Daily maps are numbered puzzles (No.1 … No.N), not calendar dates. One rule
// picks today's number for everyone: No. = UTC+8 days since the manifest epoch
// + 1. Opening a number keeps it (it is carried in the URL and the session),
// so a page started before midnight is still finished as the same puzzle.
// Every earlier number stays playable in the archive.

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

function dayNumber(date) {
    const [y, m, d] = date.split('-').map(Number);
    return Math.round(Date.UTC(y, m - 1, d) / DAY);
}

/** Today's daily number for a UTC+8 date (≤ 0 before the epoch). */
export function dailyNumber(manifest, date) {
    return dayNumber(date) - dayNumber(manifest.epoch) + 1;
}

/** The UTC+8 date on which a number is "today". */
export function dateOfNumber(manifest, no) {
    const t = new Date((dayNumber(manifest.epoch) + no - 1) * DAY);
    return t.toISOString().slice(0, 10);
}

/**
 * state: 'today' (a numbered puzzle for today), 'before' (bank not started),
 * 'expired' (all numbers released; the archive stays open)
 */
export function dailyStatus(manifest, date) {
    const no = dailyNumber(manifest, date);
    const entries = manifest.entries;
    if (no < 1) return { state: 'before', no, entry: null, startDate: manifest.epoch };
    const entry = entries.find(e => e.no === no) || null;
    if (entry) return { state: 'today', no, entry };
    return { state: 'expired', no, entry: null };
}

/** Numbers that may be opened today: every released number up to today's. */
export function isReleased(manifest, date, no) {
    const today = dailyNumber(manifest, date);
    return Number.isInteger(no) && no >= 1 && no <= today && manifest.entries.some(e => e.no === no);
}

/** Earlier numbers, newest first. */
export function archiveEntries(manifest, date) {
    const today = dailyNumber(manifest, date);
    return manifest.entries.filter(e => e.no < today).sort((a, b) => b.no - a.no);
}

/** What the daily tab offers: today's number and an unfinished earlier one. */
export function dailySessionPlan(snapshotDaily, manifest, date) {
    const status = dailyStatus(manifest, date);
    const sess = snapshotDaily.session;
    const record = sess ? snapshotDaily.records[sess.id] : null;
    const unfinishedOld = sess && sess.no !== status.no && !(record && record.completed) ? sess : null;
    // a new day: today's number exists and differs from the one last opened
    return { status, unfinishedOld, newDay: Boolean(sess && status.state === 'today' && sess.no !== status.no) };
}

export function countRestoredDays(records) {
    return Object.values(records).filter(r => r.completed).length;
}
