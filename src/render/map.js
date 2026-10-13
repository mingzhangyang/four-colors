// Semantic SVG map. Geometry and hit areas come from the same compiled paths.
// The renderer is a projection of committed state: animations may lag a
// region's displayed color for ~200ms but every new render settles them.

import { svg, el, clear } from './dom.js';
import { artworkSVG, borderPaths } from './scenery.js';
import { EMPTY } from '../model/rules.js';

const FILL_MS = 180;
const SWAP_MS = 250;

function defs() {
    const ink = { class: 'tex-ink' };
    return svg('defs', {}, [
        svg('pattern', { id: 'tex-0', width: 11, height: 11, patternUnits: 'userSpaceOnUse' }, [
            svg('circle', { ...ink, cx: 5.5, cy: 5.5, r: 1.5 }),
        ]),
        svg('pattern', { id: 'tex-1', width: 10, height: 10, patternUnits: 'userSpaceOnUse' }, [
            svg('path', { ...ink, class: 'tex-ink tex-stroke', d: 'M-2 2 L2 -2 M0 10 L10 0 M8 12 L12 8' }),
        ]),
        svg('pattern', { id: 'tex-2', width: 12, height: 12, patternUnits: 'userSpaceOnUse' }, [
            svg('path', { ...ink, class: 'tex-ink tex-stroke', d: 'M0 0.5 H12 M0.5 0 V12' }),
        ]),
        svg('pattern', { id: 'tex-3', width: 14, height: 14, patternUnits: 'userSpaceOnUse' }, [
            svg('circle', { class: 'tex-ink tex-stroke', cx: 7, cy: 7, r: 3.4 }),
        ]),
        svg('pattern', { id: 'sea-waves', width: 36, height: 18, patternUnits: 'userSpaceOnUse' }, [
            svg('path', { class: 'sea-line', d: 'M0 9 Q9 4 18 9 T36 9' }),
        ]),
        svg('pattern', { id: 'faded', width: 9, height: 9, patternUnits: 'userSpaceOnUse' }, [
            svg('circle', { class: 'faded-dot', cx: 2, cy: 2, r: 0.7 }),
        ]),
        svg('filter', { id: 'fiber', x: '-20%', y: '-20%', width: '140%', height: '140%' }, [
            svg('feTurbulence', { type: 'fractalNoise', baseFrequency: '0.09', numOctaves: 2, seed: 4, result: 'n' }),
            svg('feDisplacementMap', { in: 'SourceGraphic', in2: 'n', scale: 9 }),
        ]),
    ]);
}

export function createMap({ onPointerTarget = null } = {}) {
    const wrap = el('div', { class: 'map-wrap' });
    const root = svg('svg', { class: 'map', role: 'presentation', 'aria-hidden': 'true', preserveAspectRatio: 'xMidYMid meet' });
    const labelLayer = el('div', { class: 'label-layer' });
    wrap.append(root, labelLayer);

    let level = null;
    let view = null;
    let viewIndex = 0;
    let colors = [];
    let shown = []; // colors currently displayed (animations may lag)
    const anims = new Map(); // region -> { timer, nodes }
    let opts = { texture: true, labels: false, reducedMotion: false };
    let layers = {};
    let regionNodes = [];
    let textureNodes = [];
    let lastModel = null;

    function build() {
        clear(root);
        clear(labelLayer);
        anims.forEach(a => clearTimeout(a.timer));
        anims.clear();
        view = viewIndex === 0 ? level : level.views[viewIndex - 1];
        const [x, y, w, h] = view.box;
        root.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
        root.append(defs());
        layers = {
            back: svg('g', { class: 'layer-back' }),
            regions: svg('g', { class: 'layer-regions' }),
            textures: svg('g', { class: 'layer-textures' }),
            fx: svg('g', { class: 'layer-fx' }),
            ink: svg('g', { class: 'layer-ink' }),
            conflicts: svg('g', { class: 'layer-conflicts' }),
            preview: svg('g', { class: 'layer-preview' }),
            hint: svg('g', { class: 'layer-hint' }),
            marks: svg('g', { class: 'layer-marks' }),
            art: svg('g', { class: 'layer-art' }),
            labels: svg('g', { class: 'layer-labels' }),
            focus: svg('g', { class: 'layer-focus' }),
        };
        if (level.water) {
            layers.back.append(
                svg('rect', { class: 'sea', x, y, width: w, height: h }),
                svg('rect', { class: 'sea-pattern', x, y, width: w, height: h, fill: 'url(#sea-waves)' }),
            );
        }
        regionNodes = view.paths.map((d, i) => svg('path', { class: 'region', d, 'data-i': i, 'data-c': -1 }));
        textureNodes = view.paths.map((d, i) => svg('path', { class: 'texture', d, 'data-i': i }));
        layers.regions.append(...regionNodes);
        layers.textures.append(...textureNodes);
        if (view.coast) layers.ink.append(svg('path', { class: 'coast', d: view.coast }));
        const borders = borderPaths(view);
        layers.ink.append(svg('path', { class: 'ink', d: borders.inner }), svg('path', { class: 'ink ink-outer', d: borders.outer }));
        root.append(...Object.values(layers));
        buildMarks();
        buildArt();
        buildLabels();
        shown = new Array(level.adj.length).fill(null);
        if (lastModel) render(lastModel);
    }

    function buildMarks() {
        clear(layers.marks);
        const targets = new Map((level.goals.targets || []).map(([i, c]) => [i, c]));
        level.fixed.forEach((c, i) => {
            if (c === EMPTY) return;
            const [lx, ly] = view.labels[i];
            layers.marks.append(svg('g', { class: 'seal', transform: `translate(${lx} ${ly})`, 'data-i': i }, [
                svg('rect', { x: -9, y: -9, width: 18, height: 18, rx: 3.5 }),
                svg('path', { d: 'M-4.5 -0.5 H4.5 V5.5 H-4.5 Z M-2.8 -0.5 V-3 A2.8 2.8 0 0 1 2.8 -3 V-0.5' }),
            ]));
        });
        for (const [i, c] of targets) {
            const [lx, ly] = view.labels[i];
            layers.marks.append(svg('g', { class: 'target', transform: `translate(${lx} ${ly})`, 'data-i': i, 'data-c': c }, [
                svg('circle', { class: 'target-ring', r: 18 }),
                svg('circle', { class: 'target-fill', r: 12, 'data-c': c }),
                svg('circle', { class: 'target-tex', r: 12, fill: `url(#tex-${c})` }),
                svg('path', { class: 'target-check', d: 'M-6.5 0 L-2 4.5 L7 -4.5' }),
            ]));
        }
    }

    function buildArt() {
        clear(layers.art);
        layers.art.append(...artworkSVG(level, view));
    }

    function buildLabels() {
        clear(layers.labels);
        if (!opts.labels) return;
        view.labels.forEach(([lx, ly], i) => {
            const offset = level.fixed[i] !== EMPTY || (level.goals.targets || []).some(([t]) => t === i) ? -18 : 0;
            layers.labels.append(svg('text', { class: 'region-label', x: lx, y: ly + 5 + offset, 'text-anchor': 'middle' }, [level.ids[i]]));
        });
    }

    function outlineOf(i, cls) {
        return svg('path', { class: cls, d: view.paths[i] });
    }

    function edgeOf(a, b) {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const e = view.shared.find(s => s[0] === lo && s[1] === hi);
        return e ? e[2] : null;
    }

    function setShown(i, c) {
        if (shown[i] === c) return;
        shown[i] = c;
        regionNodes[i].setAttribute('data-c', c);
        textureNodes[i].setAttribute('data-c', c);
    }

    /** model: { colors, conflicts, preview, hint, focus, complete, swapPick } */
    function render(model) {
        lastModel = model;
        if (!level) return;
        colors = model.colors;
        for (let i = 0; i < colors.length; i++) {
            const a = anims.get(i);
            if (a && a.to !== colors[i]) cancelAnim(i);
            if (!anims.has(i)) setShown(i, colors[i]);
        }
        root.classList.toggle('show-texture', opts.texture);
        root.classList.toggle('is-complete', Boolean(model.complete));

        clear(layers.conflicts);
        for (const [a, b] of model.conflicts || []) {
            const d = edgeOf(a, b);
            if (!d) continue;
            layers.conflicts.append(svg('path', { class: 'conflict-halo', d }), svg('path', { class: 'conflict', d }));
        }

        clear(layers.preview);
        root.classList.toggle('has-preview', Boolean(model.preview));
        if (model.preview) {
            const { regions, locked } = model.preview;
            for (const i of regions) layers.preview.append(outlineOf(i, 'lift-shadow'));
            for (const i of regions) layers.preview.append(outlineOf(i, locked.length ? 'lift lift-locked' : 'lift'));
            for (const i of locked) layers.preview.append(outlineOf(i, 'locked-hatch'));
        }

        clear(layers.hint);
        if (model.hint) {
            for (const i of model.hint.regions || []) layers.hint.append(outlineOf(i, 'hint-region'));
            for (const [a, b] of model.hint.pairs || []) {
                const d = edgeOf(a, b);
                if (d) layers.hint.append(svg('path', { class: 'hint-edge', d }));
            }
        }

        // targets met / unmet
        for (const node of layers.marks.querySelectorAll('.target')) {
            const i = Number(node.getAttribute('data-i'));
            node.classList.toggle('met', colors[i] === Number(node.getAttribute('data-c')));
        }
        for (const node of layers.marks.querySelectorAll('.seal')) {
            const i = Number(node.getAttribute('data-i'));
            node.classList.toggle('alert', Boolean(model.preview && model.preview.locked.includes(i)));
        }

        clear(layers.focus);
        if (model.focus != null && model.focus >= 0) layers.focus.append(outlineOf(model.focus, 'focus-halo'), outlineOf(model.focus, 'focus-ring'));
        layoutLabelButtons();
    }

    function cancelAnim(i) {
        const a = anims.get(i);
        if (!a) return;
        clearTimeout(a.timer);
        for (const n of a.nodes) n.remove();
        anims.delete(i);
        setShown(i, colors[i]);
    }

    /** Paint spread from the tap point (map coordinates) across region i. */
    function animateFill(i, from, to, point) {
        if (opts.reducedMotion || to === EMPTY || !level) return;
        cancelAnim(i);
        const [x0, y0, x1, y1] = bboxOfPath(i);
        const [px, py] = point || view.labels[i];
        const r = Math.hypot(Math.max(px - x0, x1 - px), Math.max(py - y0, y1 - py)) + 16; // margin covers the fiber displacement
        const clipId = `clip-${i}-${Date.now()}`;
        const clip = svg('clipPath', { id: clipId }, [svg('path', { d: view.paths[i] })]);
        const blot = svg('circle', { class: 'spread', cx: px, cy: py, r, 'data-c': to, 'clip-path': `url(#${clipId})`, style: `--spread-ms:${FILL_MS}ms` });
        root.querySelector('defs').append(clip);
        layers.fx.append(blot);
        setShown(i, from);
        const timer = setTimeout(() => {
            blot.remove();
            clip.remove();
            anims.delete(i);
            setShown(i, colors[i]);
        }, FILL_MS + 20);
        anims.set(i, { timer, nodes: [blot, clip], to });
    }

    /** Swap: the committed colors are already shown; old colors fade out on top. */
    function animateSwap(changes) {
        if (opts.reducedMotion || !level) return;
        const nodes = [];
        for (const [i, before] of changes) {
            cancelAnim(i);
            const ghost = svg('path', { class: 'swap-ghost', d: view.paths[i], 'data-c': before, style: `--swap-ms:${SWAP_MS}ms` });
            layers.fx.append(ghost);
            nodes.push(ghost);
        }
        setTimeout(() => nodes.forEach(n => n.remove()), SWAP_MS + 30);
    }

    const bboxCache = new Map();
    function bboxOfPath(i) {
        const key = `${viewIndex}:${i}`;
        if (!bboxCache.has(key)) {
            const nums = view.paths[i].match(/-?\d+(\.\d+)?/g).map(Number);
            let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
            for (let k = 0; k < nums.length; k += 2) {
                x0 = Math.min(x0, nums[k]); x1 = Math.max(x1, nums[k]);
                y0 = Math.min(y0, nums[k + 1]); y1 = Math.max(y1, nums[k + 1]);
            }
            bboxCache.set(key, [x0, y0, x1, y1]);
        }
        return bboxCache.get(key);
    }

    function revealArt(on) {
        root.classList.toggle('reveal-art', on);
    }

    // ── geometry helpers for input and label buttons ──
    function toMap(clientX, clientY) {
        const m = root.getScreenCTM();
        if (!m) return null;
        const p = root.createSVGPoint();
        p.x = clientX;
        p.y = clientY;
        const q = p.matrixTransform(m.inverse());
        return [q.x, q.y];
    }

    function scale() {
        const m = root.getScreenCTM();
        return m ? m.a : 1;
    }

    function regionAt(clientX, clientY) {
        const hit = document.elementFromPoint(clientX, clientY);
        if (!hit) return -1;
        const node = hit.closest('[data-region-button], .region');
        if (!node || !wrap.contains(node)) return -1;
        return Number(node.getAttribute('data-i'));
    }

    /**
     * Narrow regions get a label button with the same region id. Buttons are
     * only placed where they do not overlap each other; anything left over is
     * reachable through the region list.
     */
    function layoutLabelButtons() {
        if (!level) return;
        clear(labelLayer);
        const s = scale();
        const m = root.getScreenCTM();
        if (!m) return;
        const base = wrap.getBoundingClientRect();
        const placed = [];
        view.labels.forEach(([lx, ly, r], i) => {
            if (r * s >= 15) return;
            const p = root.createSVGPoint();
            p.x = lx;
            p.y = ly;
            const q = p.matrixTransform(m);
            const cx = q.x - base.left;
            const cy = q.y - base.top;
            if (placed.some(([px, py]) => Math.hypot(px - cx, py - cy) < 34)) return;
            placed.push([cx, cy]);
            labelLayer.append(el('button', {
                class: 'region-button',
                type: 'button',
                'data-region-button': '',
                'data-i': i,
                'data-c': colors[i],
                style: `left:${cx}px;top:${cy}px`,
                'aria-label': level.ids[i],
                tabindex: '-1',
            }, [level.ids[i]]));
        });
    }

    if (typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(() => layoutLabelButtons()).observe(wrap);
    }

    if (onPointerTarget) onPointerTarget(wrap);

    return {
        element: wrap,
        svg: root,
        mount(nextLevel, nextOpts = {}) {
            level = nextLevel;
            viewIndex = 0;
            opts = { ...opts, ...nextOpts };
            lastModel = null;
            bboxCache.clear();
            build();
        },
        setOptions(next) {
            const relabel = next.labels !== undefined && next.labels !== opts.labels;
            opts = { ...opts, ...next };
            if (relabel && level) buildLabels();
            if (lastModel) render(lastModel);
        },
        setView(index) {
            if (!level || index === viewIndex || index < 0 || index > level.views.length) return;
            viewIndex = index;
            build();
        },
        get viewIndex() {
            return viewIndex;
        },
        render,
        animateFill,
        animateSwap,
        revealArt,
        toMap,
        regionAt,
        labelPoint: i => (view ? view.labels[i] : null),
        layoutLabelButtons,
    };
}
