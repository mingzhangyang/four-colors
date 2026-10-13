// Daily bank specification: numbered puzzles No.1 … No.N, generated offline
// and reviewed. Puzzles are not tied to calendar dates. One runtime rule picks
// "today": No. = (UTC+8 days since DAILY_EPOCH) + 1, so everyone gets the same
// number on the same day and a later launch never requires regenerating
// content. Released numbers are immutable (content/daily-lock.json, append
// only); the epoch is locked there too once the site is live.

export const DAILY_EPOCH = '2026-10-13';
export const DAILY_COUNT = 60;

const STYLES = [
    { type: 'voronoi', relax: 2, wobble: { amp: 4.5, coastAmp: 5 }, chapter: 1 },
    { type: 'voronoi', relax: 1, wobble: { amp: 2, coastAmp: 6 }, chapter: 2, water: ['coast', 'bay', 'strait'] },
    { type: 'voronoi', relax: 2, stretch: [1, 1.8], wobble: { amp: 3.5, coastAmp: 4 }, chapter: 3, water: [null, 'river'] },
    { type: 'voronoi', relax: 4, wobble: { amp: 3, coastAmp: 4 }, chapter: 4, water: [null, 'pond'] },
];

// Seven-step rhythm over consecutive numbers: gentle first, richer later.
const RHYTHM = [
    { regions: 10, maxSolutions: 24 },
    { regions: 11, maxSolutions: 16 },
    { regions: 12, maxSolutions: 12 },
    { regions: 13, maxSolutions: 8 },
    { regions: 14, maxSolutions: 6 },
    { regions: 16, maxSolutions: 4 },
    { regions: 17, maxSolutions: 3 },
];

export function dailySpecs() {
    const out = [];
    for (let i = 0; i < DAILY_COUNT; i++) {
        const no = i + 1;
        const style = STYLES[i % STYLES.length];
        const step = RHYTHM[i % RHYTHM.length];
        let water = style.water ? style.water[Math.floor(i / STYLES.length) % style.water.length] : null;
        if (water === 'strait' && i % 5 === 3) water = 'coast'; // traps read better on one landmass
        const id = `D${String(no).padStart(3, '0')}`;
        const gen = { ...style, seed: 5000 + i * 7, regions: step.regions, cells: Math.round(step.regions * (water ? 3 : 2.5)), water };
        delete gen.chapter;
        let puzzle;
        if (i % 5 === 3) puzzle = { type: 'trap', minClues: 2, maxClues: 6, maxSolutions: step.maxSolutions * 4, ratio: 0.45, minFix: 2, maxFix: 3 };
        else puzzle = { type: 'clues', minClues: 2, maxClues: water === 'strait' ? 11 : 9, maxSolutions: step.maxSolutions * (water === 'strait' ? 6 : 1) };
        out.push({
            id,
            revision: 1,
            no,
            chapter: style.chapter,
            name: { zh: `每日 No.${no}`, en: `Daily No.${no}` },
            gen,
            actions: ['fill', 'erase', 'swap'],
            puzzle,
        });
    }
    return out;
}
