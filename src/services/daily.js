// Numbered maps are a freely accessible puzzle bank, not a calendar.
// Retain the "daily" routes and storage names to preserve existing links and records.

export function numberedEntry(manifest, no) {
    return Number.isInteger(no) && no >= 1 ? manifest.entries.find(e => e.no === no) || null : null;
}

export function numberedBankPlan(snapshotDaily, manifest) {
    const records = snapshotDaily.records || {};
    const pending = manifest.entries.find(e => !(records[e.id] && records[e.id].completed)) || null;
    const session = snapshotDaily.session;
    const last = session && numberedEntry(manifest, session.no);
    const resume = last && last.id === session.id && last.revision === session.revision
        && !(records[last.id] && records[last.id].completed) ? last : null;
    return {
        recommended: resume || pending || manifest.entries[0] || null,
        allDone: manifest.entries.length > 0 && !pending,
    };
}

export function countRestoredMaps(records, manifest) {
    return manifest.entries.filter(e => records[e.id] && records[e.id].completed).length;
}
