// Planar geometry helpers for the offline level pipeline. Screen coordinates
// (y grows downward). A ring is an open array of [x, y] points; positive
// signed area (shoelace) means clockwise on screen, the orientation every
// region ring uses after normalisation.

export const PRECISION = 10; // fixed precision: coordinates are multiples of 0.1

export function round(v) {
    return Math.round(v * PRECISION) / PRECISION;
}

export function signedArea(ring) {
    let s = 0;
    for (let i = 0, n = ring.length; i < n; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[(i + 1) % n];
        s += x1 * y2 - x2 * y1;
    }
    return s / 2;
}

export function centroid(ring) {
    let a = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0, n = ring.length; i < n; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[(i + 1) % n];
        const f = x1 * y2 - x2 * y1;
        a += f;
        cx += (x1 + x2) * f;
        cy += (y1 + y2) * f;
    }
    if (Math.abs(a) < 1e-9) {
        const sx = ring.reduce((s, p) => s + p[0], 0) / ring.length;
        const sy = ring.reduce((s, p) => s + p[1], 0) / ring.length;
        return [sx, sy];
    }
    return [cx / (3 * a), cy / (3 * a)];
}

export function pointInRing([px, py], ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

export function distToSegment([px, py], [ax, ay], [bx, by]) {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const x = ax + t * dx - px;
    const y = ay + t * dy - py;
    return Math.sqrt(x * x + y * y);
}

export function distToRing(p, ring) {
    let d = Infinity;
    for (let i = 0, n = ring.length; i < n; i++) d = Math.min(d, distToSegment(p, ring[i], ring[(i + 1) % n]));
    return d;
}

function orient(a, b, c) {
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSegment(a, b, p, eps) {
    return Math.min(a[0], b[0]) - eps <= p[0] && p[0] <= Math.max(a[0], b[0]) + eps
        && Math.min(a[1], b[1]) - eps <= p[1] && p[1] <= Math.max(a[1], b[1]) + eps;
}

/** True when segments ab and cd touch anywhere (endpoints included). */
export function segmentsTouch(a, b, c, d, eps = 1e-9) {
    const o1 = orient(a, b, c);
    const o2 = orient(a, b, d);
    const o3 = orient(c, d, a);
    const o4 = orient(c, d, b);
    if (((o1 > eps && o2 < -eps) || (o1 < -eps && o2 > eps)) && ((o3 > eps && o4 < -eps) || (o3 < -eps && o4 > eps))) return true;
    if (Math.abs(o1) <= eps && onSegment(a, b, c, eps)) return true;
    if (Math.abs(o2) <= eps && onSegment(a, b, d, eps)) return true;
    if (Math.abs(o3) <= eps && onSegment(c, d, a, eps)) return true;
    if (Math.abs(o4) <= eps && onSegment(c, d, b, eps)) return true;
    return false;
}

export function segmentDistance(a, b, c, d) {
    if (segmentsTouch(a, b, c, d)) return 0;
    return Math.min(distToSegment(a, c, d), distToSegment(b, c, d), distToSegment(c, a, b), distToSegment(d, a, b));
}

export function isSimpleRing(ring) {
    const n = ring.length;
    if (n < 3) return false;
    for (let i = 0; i < n; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % n];
        for (let j = i + 1; j < n; j++) {
            if (j === i || (j + 1) % n === i || j === (i + 1) % n) continue;
            if (segmentsTouch(a, b, ring[j], ring[(j + 1) % n])) return false;
        }
    }
    return true;
}

export function bbox(points) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [x, y] of points) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
    }
    return [x0, y0, x1, y1];
}

/**
 * Pole of inaccessibility (after Mapbox polylabel): the interior point farthest
 * from the boundary, and that distance — the region's inscribed radius.
 */
export function polylabel(ring, precision = 0.5) {
    const [minX, minY, maxX, maxY] = bbox(ring);
    const width = maxX - minX;
    const height = maxY - minY;
    const cellSize = Math.min(width, height);
    if (cellSize === 0) return { x: minX, y: minY, d: 0 };
    const signedDist = (x, y) => {
        const d = distToRing([x, y], ring);
        return pointInRing([x, y], ring) ? d : -d;
    };
    const makeCell = (x, y, h) => {
        const d = signedDist(x, y);
        return { x, y, h, d, max: d + h * Math.SQRT2 };
    };
    const queue = [];
    let h = cellSize / 2;
    for (let x = minX; x < maxX; x += cellSize) {
        for (let y = minY; y < maxY; y += cellSize) queue.push(makeCell(x + h, y + h, h));
    }
    const [cx, cy] = centroid(ring);
    let best = makeCell(cx, cy, 0);
    const bboxCell = makeCell(minX + width / 2, minY + height / 2, 0);
    if (bboxCell.d > best.d) best = bboxCell;
    while (queue.length) {
        let bi = 0;
        for (let i = 1; i < queue.length; i++) if (queue[i].max > queue[bi].max) bi = i;
        const cell = queue.splice(bi, 1)[0];
        if (cell.d > best.d) best = cell;
        if (cell.max - best.d <= precision) continue;
        h = cell.h / 2;
        queue.push(makeCell(cell.x - h, cell.y - h, h), makeCell(cell.x + h, cell.y - h, h),
            makeCell(cell.x - h, cell.y + h, h), makeCell(cell.x + h, cell.y + h, h));
    }
    return { x: best.x, y: best.y, d: best.d };
}

/** Deterministic PRNG. */
export function mulberry32(seed) {
    let a = seed >>> 0;
    return function next() {
        a |= 0;
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function hashSeed(...parts) {
    let h = 2166136261;
    const s = parts.join('|');
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

/** Clip a convex polygon (with per-edge labels) by the half-plane n·p <= c. */
export function clipLabeled(poly, labels, nx, ny, c, label) {
    const out = [];
    const outLabels = [];
    const m = poly.length;
    const side = p => nx * p[0] + ny * p[1] - c;
    const eps = 1e-9;
    for (let k = 0; k < m; k++) {
        const P = poly[k];
        const Q = poly[(k + 1) % m];
        const sp = side(P);
        const sq = side(Q);
        const inP = sp <= eps;
        const inQ = sq <= eps;
        const nextLabel = labels[(k + 1) % m];
        if (inP && inQ) {
            out.push(Q);
            outLabels.push(nextLabel);
        } else if (inP && !inQ) {
            const t = sp / (sp - sq);
            out.push([P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t]);
            outLabels.push(label);
        } else if (!inP && inQ) {
            const t = sp / (sp - sq);
            out.push([P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t]);
            outLabels.push(labels[k]);
            out.push(Q);
            outLabels.push(nextLabel);
        }
    }
    // drop the earlier of two coincident points (its outgoing edge has zero length)
    const fp = [];
    const fl = [];
    for (let i = 0; i < out.length; i++) {
        const nxt = out[(i + 1) % out.length];
        if (out.length > 1 && Math.abs(out[i][0] - nxt[0]) < 1e-7 && Math.abs(out[i][1] - nxt[1]) < 1e-7) continue;
        fp.push(out[i]);
        fl.push(outLabels[i]);
    }
    return { poly: fp, labels: fl };
}
