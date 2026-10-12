// Clipped Voronoi cells by half-plane intersection. O(n²) is fine for the
// ≤ 80 sites a page uses. Each cell edge carries a label: the neighbouring
// site index, or a negative frame-side label.

import { clipLabeled, centroid, signedArea } from './geometry.mjs';

/** frame: convex ring with positive area. Returns [{ ring, labels }] per site. */
export function voronoiCells(sites, frame) {
    const frameLabels = frame.map((_, i) => -1 - i);
    return sites.map((s, i) => {
        let poly = frame.map(p => p.slice());
        let labels = frameLabels.slice();
        for (let j = 0; j < sites.length && poly.length; j++) {
            if (j === i) continue;
            const t = sites[j];
            const nx = t[0] - s[0];
            const ny = t[1] - s[1];
            const c = (t[0] * t[0] + t[1] * t[1] - s[0] * s[0] - s[1] * s[1]) / 2;
            ({ poly, labels } = clipLabeled(poly, labels, nx, ny, c, j));
        }
        return { ring: poly, labels };
    });
}

/** Lloyd relaxation: move each site to its cell centroid. */
export function relax(sites, frame, iterations, transform = null) {
    let pts = sites;
    for (let it = 0; it < iterations; it++) {
        const cells = voronoiCells(pts, frame);
        pts = cells.map((cell, i) => (cell.ring.length >= 3 && Math.abs(signedArea(cell.ring)) > 1e-6
            ? centroid(cell.ring) : pts[i]));
        if (transform) pts = pts.map(transform);
    }
    return pts;
}

/** Best-candidate sampling (Mitchell) inside a rectangle: evenly spread, seeded. */
export function spreadSites(count, [x0, y0, x1, y1], rng, candidates = 12) {
    const pts = [];
    for (let i = 0; i < count; i++) {
        let best = null;
        let bestD = -1;
        for (let c = 0; c < candidates; c++) {
            const p = [x0 + rng() * (x1 - x0), y0 + rng() * (y1 - y0)];
            let d = Infinity;
            for (const q of pts) d = Math.min(d, (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2);
            if (d > bestD) { bestD = d; best = p; }
        }
        pts.push(best);
    }
    return pts;
}
