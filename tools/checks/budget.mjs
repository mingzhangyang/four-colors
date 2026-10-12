#!/usr/bin/env node
// First-screen budget: the JS the entry page needs before the first page is
// playable (entry chunk + chapter 1 data), gzip-compressed, must stay ≤ 150 KB.
// Later chapters, stories and the daily bank load lazily and are reported only.

import { readFileSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const DIST = process.argv[2] || 'dist';
const BUDGET = 150 * 1024;
const html = readFileSync(join(DIST, 'index.html'), 'utf8');
const entry = [...html.matchAll(/<script[^>]+src="\/(assets\/[^"]+\.js)"/g)].map(m => m[1]);
const preload = [...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="\/(assets\/[^"]+\.js)"/g)].map(m => m[1]);
const assets = readdirSync(join(DIST, 'assets'));
const chapter1 = assets.filter(f => /^chapter-1-.*\.js$/.test(f)).map(f => `assets/${f}`);
const first = [...new Set([...entry, ...preload, ...chapter1])];
const gz = f => gzipSync(readFileSync(join(DIST, f))).length;
let total = 0;
for (const f of first) {
    const size = gz(f);
    total += size;
    console.log(`first screen  ${(size / 1024).toFixed(1).padStart(6)} KB  ${f}`);
}
for (const f of assets.filter(a => a.endsWith('.js') && !first.includes(`assets/${a}`))) {
    console.log(`lazy          ${(gz(`assets/${f}`) / 1024).toFixed(1).padStart(6)} KB  assets/${f}`);
}
const daily = readdirSync(join(DIST, 'daily'));
const dailySizes = daily.map(f => gzipSync(readFileSync(join(DIST, 'daily', f))).length);
console.log(`daily bank    ${daily.length} files, ${(Math.max(...dailySizes) / 1024).toFixed(1)} KB gzip max each (one fetched per day)`);
console.log(`first-screen JS total ${(total / 1024).toFixed(1)} KB gzip (budget ${BUDGET / 1024} KB)`);
if (total > BUDGET) {
    console.error('✗ first-screen JS budget exceeded');
    process.exit(1);
}
