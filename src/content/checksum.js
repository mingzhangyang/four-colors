// Content checksum shared by the build script, the runtime loader and the
// verifiers: FNV-1a over the canonical JSON of a compiled level (without its
// own `checksum` field). Generated modules keep key order stable, so the
// runtime can recompute it exactly.

export function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

export function levelChecksum(level) {
    const rest = {};
    for (const key of Object.keys(level)) if (key !== 'checksum') rest[key] = level[key];
    return fnv1a(JSON.stringify(rest));
}

export function verifyLevel(level) {
    return Boolean(level && typeof level.checksum === 'string' && levelChecksum(level) === level.checksum);
}
