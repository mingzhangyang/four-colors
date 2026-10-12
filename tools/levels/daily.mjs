// Daily bank specification. The bank is generated offline, reviewed, and then
// assigned to UTC+8 dates by an immutable manifest (content/daily-lock.json).
// Entries are never rewritten once dated; new puzzles are only appended.

export const DAILY_START = '2026-10-12';
export const DAILY_COUNT = 60;
export const FEATURED_COUNT = 12;

const STYLES = [
    { type: 'voronoi', relax: 2, wobble: { amp: 4.5, coastAmp: 5 }, chapter: 1 },
    { type: 'voronoi', relax: 1, wobble: { amp: 2, coastAmp: 6 }, chapter: 2, water: ['coast', 'bay', 'strait'] },
    { type: 'voronoi', relax: 2, stretch: [1, 1.8], wobble: { amp: 3.5, coastAmp: 4 }, chapter: 3, water: [null, 'river'] },
    { type: 'voronoi', relax: 4, wobble: { amp: 3, coastAmp: 4 }, chapter: 4, water: [null, 'pond'] },
];

// Weekly rhythm: gentle early in the week, richer at the weekend.
const WEEK = [
    { regions: 10, maxSolutions: 24 },
    { regions: 11, maxSolutions: 16 },
    { regions: 12, maxSolutions: 12 },
    { regions: 13, maxSolutions: 8 },
    { regions: 14, maxSolutions: 6 },
    { regions: 16, maxSolutions: 4 },
    { regions: 17, maxSolutions: 3 },
];

export function dateAt(start, offset) {
    const [y, m, d] = start.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d + offset));
    return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

export function dailySpecs() {
    const out = [];
    for (let i = 0; i < DAILY_COUNT; i++) {
        const date = dateAt(DAILY_START, i);
        const [y, m, d] = date.split('-').map(Number);
        const weekday = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // Monday = 0
        const style = STYLES[i % STYLES.length];
        const week = WEEK[weekday];
        let water = style.water ? style.water[Math.floor(i / STYLES.length) % style.water.length] : null;
        if (water === 'strait' && i % 5 === 3) water = 'coast'; // traps read better on one landmass
        const id = `D${String(i + 1).padStart(3, '0')}`;
        const gen = { ...style, seed: 5000 + i * 7, regions: week.regions, cells: Math.round(week.regions * (water ? 3 : 2.5)), water };
        delete gen.chapter;
        let puzzle;
        if (i % 5 === 3) puzzle = { type: 'trap', minClues: 2, maxClues: 6, maxSolutions: week.maxSolutions * 4, ratio: 0.45, minFix: 2, maxFix: 3 };
        else puzzle = { type: 'clues', minClues: 2, maxClues: water === 'strait' ? 11 : 9, maxSolutions: week.maxSolutions * (water === 'strait' ? 6 : 1) };
        out.push({
            id,
            revision: 1,
            date,
            chapter: style.chapter,
            name: { zh: `${m}月${d}日`, en: date },
            gen,
            actions: ['fill', 'erase', 'swap'],
            puzzle,
        });
    }
    return out;
}
