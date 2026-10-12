// Chapter metadata: names, worlds and per-chapter pigment mappings. A palette
// only re-skins logical colors 0–3; within one level the mapping is stable.

export const CHAPTERS = [
    {
        id: 1,
        name: { zh: '晨光原野', en: 'Morning Fields' },
        blurb: { zh: '暖白纸上的田畦与村庄。相邻、角点与颜色的复用。', en: 'Furrows and hamlets on warm white paper: neighbours, corners and reusing color.' },
        world: 'field',
        palette: ['#c9654f', '#ddb858', '#4c8b86', '#6a6eab'],
    },
    {
        id: 2,
        name: { zh: '海湾城镇', en: 'Harbor Town' },
        blurb: { zh: '矿物蓝的海湾、码头与几何街区。固定印章与最拥挤的区域。', en: 'Mineral-blue bays, piers and tidy blocks: fixed seals and the busiest regions first.' },
        world: 'harbor',
        palette: ['#c46a52', '#d9b45e', '#3f8a9a', '#5b6aa8'],
    },
    {
        id: 3,
        name: { zh: '折叠山谷', en: 'Folded Valley' },
        blurb: { zh: '层叠纸雕的山地、长边界与桥。连锁重排与看似不相邻的地块。', en: 'Layered paper hills, long borders and bridges: chain rearrangements and deceptive shapes.' },
        world: 'valley',
        palette: ['#b9624e', '#cfae5a', '#5a8a6c', '#6f679f'],
    },
    {
        id: 4,
        name: { zh: '万象花园', en: 'Garden of Myriad Forms' },
        blurb: { zh: '彩色镶嵌与庭院纹样。双色交换，局部与全局。', en: 'Colored mosaics and courtyards: the two-color swap, local and global.' },
        world: 'garden',
        palette: ['#cf5f5a', '#e0b84f', '#4f9480', '#7a64a8'],
    },
];

export const SKINS = {
    atlas: null, // use the chapter palette
    mist: ['#d98f7c', '#e5cc87', '#83b3ad', '#9799c8'],
    contrast: ['#b3341c', '#f0be22', '#0f7a6b', '#3b3d9c'],
};

export function chapterById(id) {
    return CHAPTERS.find(c => c.id === id) || CHAPTERS[0];
}

export function paletteFor(chapterId, skin = 'atlas') {
    return SKINS[skin] || chapterById(chapterId).palette;
}
