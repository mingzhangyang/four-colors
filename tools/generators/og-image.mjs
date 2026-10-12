#!/usr/bin/env node
// Renders the social card (public/og.png, 1200×630) and PNG app icons from
// vector sources with headless Chromium. Puzzle boundaries come from the
// compiled levels; nothing here is hand-painted raster art.
//   node tools/generators/og-image.mjs

import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const chapters = await Promise.all([1, 2, 3, 4].map(n => import(`../../src/content/generated/chapter-${n}.js`).then(m => m.default)));
const { CHAPTERS } = await import('../../src/content/chapters.js');

function mapSvg(lv, w) {
    const pal = CHAPTERS[lv.chapter - 1].palette;
    const [x, y, bw, bh] = lv.box;
    const h = Math.round((w * bh) / bw);
    const fills = lv.paths.map((d, i) => `<path d="${d}" fill="${pal[lv.witness[i]]}"/>`).join('');
    const sea = lv.water ? `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" fill="#bdd4d3"/>` : '';
    return `<svg viewBox="${x} ${y} ${bw} ${bh}" width="${w}" height="${h}">${sea}${fills}<path d="${lv.outline}" fill="none" stroke="#2b3337" stroke-width="2.2" stroke-linejoin="round"/></svg>`;
}

const picks = [chapters[0][7], chapters[1][5], chapters[2][3], chapters[3][6]];
const og = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;width:1200px;height:630px;background:#e8decb;font-family:"Noto Serif CJK SC","Songti SC","Noto Serif SC",serif;color:#2b3337;display:flex;align-items:center;justify-content:center}
.page{width:1120px;height:550px;background:#f7f0e3;border-radius:10px 22px 22px 10px;box-shadow:0 2px 4px rgba(70,48,14,.15),0 18px 40px rgba(70,48,14,.18);display:grid;grid-template-columns:430px 1fr;align-items:center;padding:0 48px;box-sizing:border-box;gap:30px}
h1{font-size:76px;margin:0;letter-spacing:.08em}
h2{font-size:34px;margin:6px 0 22px;font-weight:500;color:#5c6467;letter-spacing:.04em}
p{font-size:24px;margin:0;color:#5c6467;font-family:"Noto Sans CJK SC",system-ui,sans-serif;line-height:1.5}
.maps{display:flex;gap:18px;align-items:flex-end;justify-content:center}
.maps svg{border-radius:6px;background:#fcf9f2;box-shadow:0 2px 6px rgba(70,48,14,.18)}
.maps svg:nth-child(odd){transform:rotate(-2deg)}.maps svg:nth-child(even){transform:rotate(2deg) translateY(-14px)}
.seal{display:inline-block;margin-top:26px;padding:8px 16px;border:3px solid #a63d2a;color:#a63d2a;border-radius:8px;font-size:26px;transform:rotate(-6deg);letter-spacing:.12em}
</style></head><body><div class="page"><div><h1>四色图志</h1><h2>Fourfold Atlas</h2><p>用四种颜色修复一部失色地图册<br>Restore a faded atlas with four colors</p><span class="seal">已修复</span></div>
<div class="maps">${picks.map(lv => mapSvg(lv, 140)).join('')}</div></div></body></html>`;

const iconSvg = size => `<!doctype html><html><body style="margin:0"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" width="${size}" height="${size}"><rect width="240" height="240" fill="#f7f0e3"/><path d="M120 120L120 26A94 94 0 0 1 201.4 167Z" fill="#c9654f" stroke="#f7f0e3" stroke-width="6"/><path d="M120 120L201.4 167A94 94 0 0 1 38.6 167Z" fill="#ddb858" stroke="#f7f0e3" stroke-width="6"/><path d="M120 120L38.6 167A94 94 0 0 1 120 26Z" fill="#4c8b86" stroke="#f7f0e3" stroke-width="6"/><circle cx="120" cy="120" r="36" fill="#6a6eab" stroke="#f7f0e3" stroke-width="6"/></svg></body></html>`;

const browser = await chromium.launch();
async function render(html, width, height, file) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.setContent(html);
    await page.waitForTimeout(200);
    writeFileSync(join(ROOT, file), await page.screenshot({ type: 'png' }));
    await page.close();
    console.log(`wrote ${file}`);
}
await render(og, 1200, 630, 'public/og.png');
await render(iconSvg(180), 180, 180, 'public/apple-touch-icon.png');
await render(iconSvg(512), 512, 512, 'public/icon-512.png');
await browser.close();
