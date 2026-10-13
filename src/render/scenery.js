// Art direction lives outside immutable puzzle data. Every vignette fits inside
// a certified label circle, leaving borders, fixed seals and targets untouched.
// The same paths are used by the play map, collection thumbnails and PNG export.
import { LANDMARKS } from './landmarks.js';
import { svg } from './dom.js';

export const ART_SAMPLES = ['FC01', 'FC16', 'FC23', 'FC32'];

// Coordinates, including control points, stay within a radius of 34 units.
export const SCENES = {
    field: [
        { d: 'M-17 1 L-9 -7 L-1 1 V12 H-17 Z M1 -3 L9 -11 L17 -3 V9 H1 Z', fill: true },
        { d: 'M-20 1 L-9 -10 L2 1 M-14 12 V3 H-5 V12 M-11 -3 H-8 M-2 -3 L9 -14 L20 -3 M6 9 V0 H12 V9' },
        { d: 'M-23 16 Q-4 11 22 16 M-20 21 Q-4 16 18 21 M-12 25 Q0 22 12 25 M-24 -9 V1 M-27 -9 Q-24 -19 -21 -9 Z M21 -11 V-2 M18 -11 Q21 -21 24 -11 Z' },
    ],
    harbor: [
        { d: 'M-20 7 H15 L8 15 H-12 Z M-3 -20 L-3 3 H13 Z', fill: true },
        { d: 'M-20 7 H15 L8 15 H-12 Z M-3 7 V-22 M-3 -20 L13 3 H-3 M-7 -13 L-17 3 H-7 Z M-25 20 Q-19 16 -13 20 T-1 20 T11 20 T23 20 M-17 25 Q-11 21 -5 25 T7 25' },
        { d: 'M9 -19 Q13 -23 17 -19 Q21 -23 25 -19 M-25 -13 Q-22 -16 -19 -13 M19 -2 V9 M24 -2 V9 M17 -3 H26' },
    ],
    valley: [
        { d: 'M-25 12 L-8 -20 L4 -1 L13 -13 L27 12 Z', fill: true },
        { d: 'M-25 12 L-8 -20 L11 12 M2 -3 L13 -13 L27 12 M-14 -9 L-8 -20 L-2 -10 L-7 -7 Z M8 -6 L13 -13 L17 -6 M-22 18 Q-9 12 0 18 T23 18 M-16 24 Q-5 18 5 24 T17 24' },
        { d: 'M-21 6 V-1 M-26 -1 L-21 -11 L-16 -1 Z M18 16 V8 M13 8 L18 -3 L23 8 Z M-2 12 L2 7 L5 12' },
    ],
    garden: [
        { d: 'M-17 -3 Q0 -22 17 -3 Z M-11 -3 H11 V13 H-11 Z', fill: true },
        { d: 'M-19 -3 Q0 -23 19 -3 Z M0 -15 V-22 M-12 -3 V14 M12 -3 V14 M-17 14 H17 M-4 14 V4 A4 4 0 0 1 4 4 V14 M-9 20 Q0 16 9 20 M-6 25 H6' },
        { d: 'M-23 13 V-2 M-23 7 Q-31 4 -27 0 Q-22 1 -23 7 M-23 1 Q-16 -3 -19 -7 Q-24 -5 -23 1 M23 13 V-2 M23 7 Q31 4 27 0 Q22 1 23 7 M23 1 Q16 -3 19 -7 Q24 -5 23 1' },
    ],
};

const DETAILS = {
    field: [{ d: LANDMARKS.windmill }, { d: 'M-24 18 Q-8 12 23 18 M-20 23 Q-5 18 19 23 M-24 9 L-17 6 M18 7 L25 10' }],
    harbor: [{ d: LANDMARKS.lighthouse }, { d: 'M-25 19 Q-19 15 -13 19 T-1 19 T11 19 T23 19 M-18 25 Q-12 21 -6 25 T6 25 M-18 -17 Q-14 -21 -10 -17' }],
    valley: [{ d: LANDMARKS.bridge }, { d: 'M-22 19 Q-8 15 0 19 T23 19 M-17 25 Q-5 20 7 25 M-24 -5 L-18 -18 L-12 -5 M15 -7 L21 -20 L27 -7' }],
    garden: [{ d: LANDMARKS.fountain }, { d: 'M-24 14 Q-29 0 -22 -9 Q-17 0 -24 14 M24 14 Q29 0 22 -9 Q17 0 24 14 M-18 22 Q0 16 18 22' }],
};

// Partition already-compiled shared edges; no boundary is redrawn or displaced.
export function borderPaths(view) {
    const parts = path => (path.match(/M[^M]+/g) || []).map(d => d.trim());
    const inner = new Set(view.shared.flatMap(([, , d]) => parts(d)));
    return { inner: [...inner].join(' '), outer: parts(view.outline).filter(d => !inner.has(d)).join(' ') };
}

const WORLDS = ['field', 'harbor', 'valley', 'garden'];

export function artworkFor(level, view = level) {
    if (!ART_SAMPLES.includes(level.id)) {
        return view === level ? level.art.filter(([, kind]) => LANDMARKS[kind]).map(([region, kind, x, y, scale]) =>
            ({ region, x, y, scale, paths: [{ d: LANDMARKS[kind] }] })) : [];
    }
    const targets = new Set((level.goals.targets || []).map(([i]) => i));
    return view.labels.map(([x, y, radius], region) => ({ region, x, y, radius }))
        .filter(({ region }) => level.fixed[region] < 0 && !targets.has(region))
        .sort((a, b) => b.radius - a.radius || a.region - b.region)
        .slice(0, level.id === 'FC01' ? 4 : 5)
        .map(({ region, x, y, radius }, k) => ({
            region, x, y, scale: Math.min(3.5, radius * 0.78 / 34),
            paths: (k % 2 ? DETAILS : SCENES)[WORLDS[level.chapter - 1]],
        }));
}

export function artworkSVG(level, view = level, { thumbnail = false } = {}) {
    return artworkFor(level, view).map(({ region, x, y, scale, paths }, k) =>
        svg('g', {
            class: thumbnail ? 'thumb-art' : 'landmark', 'data-art-region': region,
            transform: `translate(${x} ${y}) scale(${scale})`, style: `--delay:${Math.min(k * 100, 500)}ms`,
        }, paths.flatMap(({ d, fill }) => fill
            ? [svg('path', { class: 'landmark-wash', d })]
            : [svg('path', { class: 'landmark-halo', d }), svg('path', { class: 'landmark-ink', d })])));
}

export function chapterPlate(chapter) {
    const paths = SCENES[WORLDS[chapter - 1]];
    return svg('svg', { class: 'chapter-plate', viewBox: '-45 -36 90 72', 'aria-hidden': 'true' }, [
        svg('circle', { class: 'plate-sun', cx: 13, cy: -10, r: 21 }),
        svg('path', { class: 'plate-rule', d: 'M-40 29 H40 M-35 33 H35' }),
        ...paths.map(({ d, fill }) => svg('path', { d, class: fill ? 'landmark-wash' : 'plate-ink' })),
    ]);
}
