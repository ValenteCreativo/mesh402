import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { createBridge, root } from './bridge.js';
import { createPublicApi } from './public-api/route.js';
const port = Number(process.env.PORT ?? 4020);
const origin = process.env.PUBLIC_ORIGIN ?? (process.env.NODE_ENV === 'production' ? '' : `http://127.0.0.1:${port}`);
if (!origin || new URL(origin).origin !== origin) throw new Error('PUBLIC_ORIGIN must be the exact public origin');
const bridge = await createBridge({ origin });
const publicApi = await createPublicApi({
  enabled: process.env.PUBLIC_API_ENABLED === 'true', origin,
  recipient: process.env.HEDERA_PAY_TO_ACCOUNT_ID ?? '', dataDir: resolve(root, 'generated'),
  providerReady: !!process.env.TRIPO_API_KEY,
  maxGenerations: Number(process.env.PUBLIC_API_MAX_GENERATIONS ?? 5),
  maxConcurrent: Number(process.env.PUBLIC_API_MAX_CONCURRENT ?? 1),
});
const directory = resolve(root, 'dist-visual');
const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.glb': 'model/gltf-binary', '.json': 'application/json', '.ttf': 'font/ttf', '.txt': 'text/plain' };
const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  try {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://local').pathname);
    if (path === '/health' && req.method === 'GET') { res.setHeader('Content-Type', 'application/json'); res.end('{"status":"ok"}'); return; }
    if (await publicApi(req, res)) return;
    if (await bridge(req, res)) return;
    // Unknown API routes remain separate from operator authorization and static files.
    if (!['GET', 'HEAD'].includes(req.method ?? '') || path.startsWith('/api/') || path.split('/').some(p => p.startsWith('.'))) { res.writeHead(404); res.end(); return; }
    const file = resolve(directory, '.' + (path === '/' ? '/index.html' : path === '/operator' ? '/operator.html' : path));
    if (!file.startsWith(directory + sep) || !types[extname(file)]) { res.writeHead(404); res.end(); return; }
    const info = await stat(file); if (!info.isFile()) throw new Error('Not a file');
    res.setHeader('Content-Type', types[extname(file)]); res.setHeader('Content-Length', info.size);
    res.setHeader('Cache-Control', extname(file) === '.glb' ? 'public, max-age=3600' : 'no-cache');
    if (req.method === 'HEAD') res.end(); else createReadStream(file).on('error', () => res.destroy()).pipe(res);
  } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
});
server.requestTimeout = 0; server.timeout = 0;
server.listen(port, '0.0.0.0', () => console.log(`Mesh402 production wrapper listening on port ${port}; mode=${process.env.MESH402_UI_EXECUTION ?? 'dry-run'}`));
