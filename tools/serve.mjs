/**
 * Minimal static file server — zero dependencies.
 * Serves ./dist (or the project root with --root) for local preview.
 *
 * Usage: node tools/serve.mjs [--port 4173] [--root dist]
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve, dirname, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const arg = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const PORT = Number(arg('--port', process.env.PORT || 4173));
const BASE = resolve(ROOT, arg('--root', 'dist'));

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.pdf': 'application/pdf',
    '.woff2': 'font/woff2',
    '.txt': 'text/plain; charset=utf-8'
};

const server = createServer(async (req, res) => {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        let pathname = decodeURIComponent(url.pathname);
        if (pathname.endsWith('/')) pathname += 'index.html';

        const filePath = normalize(join(BASE, pathname));
        if (!filePath.startsWith(BASE + sep) && filePath !== BASE) {
            res.writeHead(403).end('Forbidden');
            return;
        }

        let info;
        try {
            info = await stat(filePath);
        } catch {
            res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
                .end('<h1>404 — Not found</h1>');
            return;
        }

        const target = info.isDirectory() ? join(filePath, 'index.html') : filePath;
        const body = await readFile(target);
        const type = MIME[extname(target).toLowerCase()] || 'application/octet-stream';

        const headers = {
            'Content-Type': type,
            'Content-Length': body.length,
            'Cache-Control': 'no-cache',
            'X-Content-Type-Options': 'nosniff'
        };
        if (extname(target).toLowerCase() === '.pdf') {
            headers['Content-Disposition'] = 'inline; filename="Md-Rezwanul-Haque-CV.pdf"';
        }

        res.writeHead(200, headers).end(body);
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
            .end(`500 — ${error.message}`);
    }
});

server.listen(PORT, () => {
    console.log(`Serving ${BASE}`);
    console.log(`  http://localhost:${PORT}/`);
    console.log(`  http://localhost:${PORT}/assets/${'Md-Rezwanul-Haque-CV.pdf'}`);
});
