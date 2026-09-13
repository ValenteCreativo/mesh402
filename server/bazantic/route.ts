import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { generateAsset } from '../../src/tripo/client.js';
import { persistGlb } from '../../src/tripo/persist.js';
import { writeJson } from '../storage.js';

const defaults = { generate: generateAsset, persist: persistGlb };
export type BazanticDependencies = typeof defaults;
type Config = { origin: string; dataDir: string; secret: string; providerReady: boolean };
const taskPattern = /^[a-f0-9-]{36}$/;
const digest = (value: string) => createHash('sha256').update(value).digest();

/** Trusted gateway upstream: no Hedera payment handling or operator credentials. */
export async function createBazanticApi(config: Config, deps: BazanticDependencies = defaults) {
  const directory = resolve(config.dataDir, 'bazantic');
  await mkdir(directory, { recursive: true });
  const lock = resolve(directory, 'execution.lock');
  let busy = false;
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const path = new URL(req.url ?? '/', config.origin).pathname;
    if (!path.startsWith('/api/bazantic/')) return false;
    res.setHeader('Cache-Control', 'no-store');
    const reply = (status: number, body: unknown) => {
      res.statusCode = status; res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body)); return true;
    };
    const error = (status: number, code: string) => reply(status, { error: { code } });
    try {
      const match = path.match(/^\/api\/bazantic\/(assets|receipts)\/([a-f0-9-]{36})\.(glb|json)$/);
      if (match && ['GET', 'HEAD'].includes(req.method ?? '')) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        if ((match[1] === 'assets') !== (match[3] === 'glb')) return error(404, 'not_found');
        let receipt;
        try { receipt = JSON.parse(await readFile(resolve(directory, `${match[2]}.json`), 'utf8')); }
        catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return error(404, 'asset_not_registered'); throw e; }
        if (match[1] === 'receipts') return reply(200, receipt);
        const file = resolve(config.dataDir, `${match[2]}.glb`), info = await stat(file);
        res.setHeader('Content-Type', 'model/gltf-binary'); res.setHeader('Content-Length', info.size);
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        if (req.method === 'HEAD') res.end(); else createReadStream(file).on('error', () => res.destroy()).pipe(res);
        return true;
      }
      if (path !== '/api/bazantic/generate') return error(404, 'not_found');
      if (req.method !== 'POST') return error(405, 'method_not_allowed');
      if (!config.secret) return error(503, 'bazantic_not_configured');
      const supplied = req.headers['x-bazantic-upstream-secret'];
      if (typeof supplied !== 'string' || !timingSafeEqual(digest(supplied), digest(config.secret))) return error(401, 'unauthorized');
      if (!config.providerReady) return error(503, 'generation_not_configured');
      if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') return error(415, 'json_required');
      let input;
      try {
        let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 16384) return error(413, 'body_too_large'); }
        input = JSON.parse(raw);
        if (!input || Object.keys(input).length !== 1 || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 2000) return error(400, 'invalid_prompt');
      } catch { return error(400, 'invalid_json'); }
      if (busy) return error(409, 'generation_in_progress');
      // A retained disk lock blocks repeats after a crash or ambiguous provider failure.
      busy = true;
      try { const handle = await open(lock, 'wx', 0o600); await handle.close(); }
      catch (e) { busy = false; if ((e as NodeJS.ErrnoException).code === 'EEXIST') return error(409, 'reconciliation_required'); throw e; }
      let taskId: string | null = null;
      try {
        const asset = await deps.generate(input.prompt.trim(), {
          onResponse: (endpoint, envelope) => {
            if (endpoint === '/generation/text-to-model' && envelope.code === 0) {
              const created = (envelope.data as any)?.task_id;
              if (typeof created === 'string' && taskPattern.test(created)) taskId = created;
            }
          },
        });
        if (!taskPattern.test(asset.taskId)) throw new Error('Invalid task ID');
        taskId = asset.taskId;
        const file = await deps.persist(asset);
        const result = { status: 'success', taskId, assetUrl: `${config.origin}/api/bazantic/assets/${taskId}.glb`,
          receiptUrl: `${config.origin}/api/bazantic/receipts/${taskId}.json`,
          creditsConsumed: asset.consumedCredit ?? null, glbBytes: file.glbBytes, prompt: input.prompt.trim() };
        await writeJson(resolve(directory, `${taskId}.json`), result);
        await unlink(lock);
        return reply(200, result);
      } catch {
        return reply(502, { error: { code: 'execution_requires_reconciliation' }, taskId, retryable: false });
      } finally { busy = false; }
    } catch { return error(503, 'bazantic_unavailable'); }
  };
}
