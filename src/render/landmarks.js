// Reusable fine-line landmarks drawn in ink once a page is restored. Each is a
// stroke path inside a 32×32 box centred on (0, 0). They are placed only inside
// a logical region (at its label point) and never take pointer events.

export const LANDMARKS = {
    roof: 'M-13 3 L0 -9 L13 3 M-9 0 V12 H9 V0 M-3 12 V5 H3 V12 M5 -4 V-9 H8 V-1',
    field: 'M-14 -9 Q0 -13 14 -9 M-14 -3 Q0 -7 14 -3 M-14 3 Q0 -1 14 3 M-14 9 Q0 5 14 9 M-6 -12 V-14 M2 -12 V-14',
    windmill: 'M0 -3 L-4 13 H4 Z M0 -3 L-9 -12 L-6 -14 Z M0 -3 L9 -12 L11 -9 Z M0 -3 L-9 6 L-11 3 Z M0 -3 L9 6 L6 8 Z',
    tree: 'M0 13 V1 M0 4 L-4 0 M0 1 C-11 1 -11 -14 0 -14 C11 -14 11 1 0 1',
    haystack: 'M-12 12 Q-12 -6 0 -11 Q12 -6 12 12 Z M-9 4 H9 M-11 8 H11 M-4 -6 L-2 -12 M3 -7 L1 -12',
    boat: 'M-14 4 H14 L9 11 H-9 Z M0 4 V-13 L10 1 H0 M-12 14 Q-6 12 0 14 Q6 16 12 14',
    lighthouse: 'M-5 14 L-3 -5 H3 L5 14 Z M-4 -5 V-10 H4 V-5 M-2 -10 L0 -13 L2 -10 M-13 -9 L-6 -7 M13 -9 L6 -7 M-4 3 H4',
    house: 'M-13 12 V-1 L-7 -7 L-1 -1 V12 M-1 12 V-5 H12 V12 M-14 12 H14 M3 1 H9 M3 6 H9 M-9 5 H-5 V12',
    fish: 'M-12 0 C-6 -8 5 -8 9 0 C5 8 -6 8 -12 0 Z M9 0 L15 -6 V6 Z M-6 -1 L-5 -1 M-1 -5 Q1 0 -1 5',
    anchor: 'M0 -9 V12 M-6 -4 H6 M0 -13 m-3 0 a3 3 0 1 0 6 0 a3 3 0 1 0 -6 0 M-11 4 C-10 10 -5 12 0 12 C5 12 10 10 11 4 M-13 6 L-11 3 L-8 6 M13 6 L11 3 L8 6',
    mountain: 'M-15 12 L-4 -9 L2 1 L7 -5 L15 12 Z M-8 -2 L-4 -9 L-1 -3 M-2 6 L4 6',
    bridge: 'M-15 4 Q0 -11 15 4 M-15 -1 H15 M-15 -1 V12 M15 -1 V12 M-9 -1 V-5 M-3 -1 V-8 M3 -1 V-8 M9 -1 V-5 M-12 12 Q0 9 12 12',
    pine: 'M0 -14 L-7 -3 H-3 L-10 7 H10 L3 -3 H7 Z M0 7 V13',
    pagoda: 'M-12 -4 H12 L8 -9 H-8 Z M-10 4 H10 L6 0 H-6 Z M-6 -4 V0 M6 -4 V0 M-5 4 V12 H5 V4 M0 -9 V-14 M-8 12 H8',
    waterfall: 'M-12 -12 Q0 -14 12 -12 M-6 -12 V9 M0 -12 V11 M6 -12 V9 M-13 12 Q-6 8 0 12 Q6 16 13 12',
    flower: 'M0 13 V3 M0 8 Q-6 6 -8 2 M0 -3 m-3 0 a3 3 0 1 0 6 0 a3 3 0 1 0 -6 0 M0 -6 C-3 -14 3 -14 0 -6 M3 -3 C11 -6 11 0 3 -3 M0 0 C3 8 -3 8 0 0 M-3 -3 C-11 0 -11 -6 -3 -3',
    fountain: 'M-12 10 H12 L9 14 H-9 Z M0 10 V-4 M0 -4 C-6 -11 -10 -4 -11 4 M0 -4 C6 -11 10 -4 11 4 M0 -4 V-12 M-3 -12 H3',
    pavilion: 'M-15 -3 Q0 -14 15 -3 Z M-10 -3 V12 M10 -3 V12 M-13 12 H13 M0 -14 V-10 M-10 4 H10',
    koi: 'M-11 6 C-6 -6 6 -9 11 -2 C7 4 -2 8 -11 6 Z M11 -2 L15 -7 M11 -2 L15 3 M-4 2 Q-2 -1 1 0 M-13 10 Q0 6 13 10',
    gate: 'M-14 14 V-12 H14 V14 M-15 -12 H15 M-9 13 V3 A9 10 0 0 1 9 3 V13',
};

export const LANDMARK_KINDS = Object.keys(LANDMARKS);
