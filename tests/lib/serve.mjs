// Minimal static server for browser tests: serves a directory (default dist/).
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.webmanifest': 'application/manifest+json',
    '.txt': 'text/plain; charset=utf-8',
    '.xml': 'application/xml',
};

export function startServer(dir, port = 0, { delayDaily = 0, failDaily = false } = {}) {
    const root = resolve(dir);
    const server = createServer(async (req, res) => {
        try {
            let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
            if (p.endsWith('/')) p += 'index.html';
            const file = join(root, normalize(p).replace(/^([/\\])+/, ''));
            if (!file.startsWith(root)) throw new Error('outside');
            if (p.startsWith('/daily/')) {
                if (server.failDaily ?? failDaily) { res.writeHead(503); res.end('unavailable'); return; }
                const d = server.delayDaily ?? delayDaily;
                if (d) await new Promise(r => setTimeout(r, d));
            }
            const s = await stat(file).catch(() => null);
            if (!s || !s.isFile()) {
                const notFound = await readFile(join(root, '404.html')).catch(() => 'not found');
                res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
                res.end(notFound);
                return;
            }
            res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
            res.end(await readFile(file));
        } catch {
            res.writeHead(500);
            res.end('error');
        }
    });
    return new Promise(r => server.listen(port, '127.0.0.1', () => r({ server, port: server.address().port, close: () => new Promise(c => server.close(c)) })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const dir = process.argv[2] || 'dist';
    const port = Number(process.argv[3] || 4173);
    startServer(dir, port).then(({ port: p }) => console.log(`serving ${dir} on http://127.0.0.1:${p}`));
}
