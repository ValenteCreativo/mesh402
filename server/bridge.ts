import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { publicEvidence } from './evidence.js';
import { operatorGate } from './operator.js';
import { storage } from './storage.js';

export const root = fileURLToPath(new URL('..', import.meta.url));
export async function createBridge(options: { origin: string; dataDir?: string; mode?: string; secret?: string }) {
  const executionMode = options.mode ?? process.env.MESH402_UI_EXECUTION ?? 'dry-run';
  if (!['dry-run', 'live'].includes(executionMode)) throw new Error('Invalid MESH402_UI_EXECUTION');
  const dryRun = executionMode === 'dry-run';
  const dataDir = options.dataDir ?? resolve(root, 'generated');
  if (!dryRun && dataDir !== resolve(root, 'generated')) throw new Error('Paid CLI requires the project generated directory');
  const state = await storage(resolve(dataDir, 'wrapper'), executionMode);
  const gate = operatorGate(options.secret ?? process.env.LIVE_OPERATOR_SECRET, options.origin);
  const replay = JSON.parse(await readFile(resolve(root, 'frontend/public/assets/replay/manifest.json'), 'utf8'));
  const executionCwd = dryRun ? resolve(dataDir, 'ui-dry-run') : root;
  const executionReceipt = resolve(executionCwd, 'generated/mesh402-agent-receipt.json');
  const clean = (value: unknown) => {
    let result = JSON.stringify(value);
    for (const [key, secret] of Object.entries(process.env)) {
      if (secret && /KEY|SECRET|TOKEN|PASSWORD/i.test(key)) result = result.split(secret).join('[REDACTED]');
    }
    return JSON.parse(result.replace(/\/Users\/[^\s"\\]+/g, '[LOCAL_PATH]'));
  };
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const path = new URL(req.url ?? '/', 'http://local').pathname;
    if (!path.startsWith('/demo/')) return false; // Future caller-paid /api/* has a separate payment boundary.
    const json = (status: number, value: unknown) => {
      res.statusCode = status; res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(clean(value))); return true;
    };
    const body = async () => {
      let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 12000) throw new Error('Request too large'); }
      return raw;
    };
    try {
      if (path === '/demo/config' && req.method === 'GET') return json(200, { executionMode, operatorAuthorized: gate.authorized(req) });
      if (path === '/demo/evidence' && req.method === 'GET') return json(200, replay);
      if (path === '/demo/receipt' && req.method === 'GET') {
        res.setHeader('Content-Disposition', 'attachment; filename="mesh402-replay.json"'); return json(200, replay);
      }
      const receiptMatch = path.match(/^\/demo\/receipts\/([a-f0-9-]{36})\.json$/);
      if (receiptMatch && req.method === 'GET') {
        const evidence = state.registry[receiptMatch[1]];
        if (!evidence) return json(404, { error: 'Unknown receipt' });
        res.setHeader('Content-Disposition', `attachment; filename="${receiptMatch[1]}.json"`); return json(200, evidence);
      }
      const asset = path.match(/^\/demo\/assets\/([a-f0-9-]{36})\.glb$/);
      if (asset && (req.method === 'GET' || req.method === 'HEAD')) {
        if (!state.registry[asset[1]]) return json(404, { error: 'Unknown asset' });
        const file = resolve(dataDir, `${asset[1]}.glb`); const info = await stat(file);
        res.setHeader('Content-Type', 'model/gltf-binary'); res.setHeader('Content-Length', info.size);
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        if (req.method === 'HEAD') res.end(); else createReadStream(file).on('error', () => res.destroy()).pipe(res);
        return true;
      }
      // Operator authentication protects only this funding source, not every paid capability.
      if (path === '/demo/operator/session' && req.method === 'POST') {
        if (!gate.sameOrigin(req)) return json(403, { error: 'Origin rejected' });
        const secret = new URLSearchParams(await body()).get('secret') ?? '';
        if (!gate.login(secret, res)) return json(401, { error: 'Operator authorization failed' });
        res.writeHead(303, { Location: '/' }); res.end(); return true;
      }
      if (path === '/demo/live' || path === '/demo/operator/state') {
        if (!gate.authorized(req)) return json(401, { error: 'Operator session required. Open /operator to authorize.' });
      }
      if (path === '/demo/operator/state' && req.method === 'GET') return json(200, state.getState() ?? { status: 'ready' });
      if (path === '/demo/live' && req.method === 'POST') {
        if (!gate.sameOrigin(req)) return json(403, { error: 'Origin rejected' });
        const input = JSON.parse(await body());
        if (input.confirm !== true || typeof input.intent !== 'string' || !input.intent.trim() || input.intent.length > 2000 || input.intent.startsWith('--')) return json(400, { error: 'Intent and explicit execution confirmation required' });
        if (!await state.claim(input.intent)) return json(409, { error: 'Execution already attempted. Human reconciliation required; no automatic retry.' });
        await mkdir(executionCwd, { recursive: true });
        const previous = await readFile(executionReceipt, 'utf8').catch(e => { if (e.code === 'ENOENT') return null; throw e; });
        res.setHeader('Content-Type', 'application/x-ndjson'); res.setHeader('Cache-Control', 'no-store'); res.flushHeaders();
        const send = (event: string, data: unknown) => { if (!res.destroyed) res.write(JSON.stringify({ event, data: clean(data) }) + '\n'); };
        const startedAt = Date.now(); send('started', { executionMode });
        // Environment is inherited server-side. Local start commands load .env.local; Render supplies env directly.
        const child = spawn(process.execPath, ['--import', 'tsx', resolve(root, 'scripts/test-agent.ts'), dryRun ? '--dry-run' : '--live', input.intent], { cwd: executionCwd, stdio: ['ignore', 'pipe', 'pipe'] });
        let recipient: string | null = null;
        const safeEvents: Record<string, string> = { toolSelection: 'tool', signedPayment: 'signed', verification: 'verified', settlement: 'settled', tripoCreation: 'created', tripoProgress: 'progress' };
        createInterface({ input: child.stdout }).on('line', line => {
          const marker = line.indexOf(': '); const event = safeEvents[line.slice(0, marker)];
          if (!event) return;
          try {
            let data = clean(JSON.parse(line.slice(marker + 2)));
            if (event === 'signed') recipient = data.recipient;
            if (event === 'created') data = { data: { task_id: data.data.task_id } };
            void state.update({ lastEvent: event, lastEventData: data }).catch(() => { /* Existing lock remains fail-closed. */ });
            send(event, data);
          } catch { /* Never proxy raw process logs. */ }
        });
        child.stderr.resume();
        child.on('error', () => { send('failed', { error: 'Agent process could not start; inspect local state. No retry.' }); });
        child.on('close', async code => {
          try {
            const saved = await readFile(executionReceipt, 'utf8');
            if (saved === previous) throw new Error('No new receipt produced');
            const receipt = JSON.parse(saved);
            if (receipt.request !== input.intent) throw new Error('Receipt request mismatch');
            const completedAt = Date.now();
            await writeFile(resolve(dataDir, `mesh402-ui-${executionMode}-receipt.json`), JSON.stringify({ startedAt: new Date(startedAt).toISOString(), completedAt: new Date(completedAt).toISOString(), executionMs: completedAt - startedAt, recipient, receipt }, null, 2), { mode: 0o600 });
            if (dryRun) {
              if (receipt.mode !== 'dry-run' || receipt.toolInvocations !== 0 || receipt.serviceEvidence || code !== 0) throw new Error('Dry-run failed; inspect the private receipt');
              if (receipt.toolResult && (receipt.toolResult.dryRun !== true || receipt.toolResult.paid !== false || receipt.toolResult.generated !== false)) throw new Error('Unexpected dry-run result');
              const result = { answer: receipt.finalAnswer, decision: receipt.decision, toolInvocations: 0, paid: false, generated: false };
              await state.update({ status: 'completed', result }); send('dry-run-complete', result);
            } else {
              if (receipt.toolResult?.asset?.status === 'success') {
                const evidence = clean({ ...publicEvidence(receipt), recipient, receiptUrl: `/demo/receipts/${receipt.toolResult.asset.tripoTaskId}.json` });
                const assetInfo = await stat(resolve(dataDir, `${evidence.taskId}.glb`));
                if (assetInfo.size !== evidence.bytes) throw new Error('Asset size mismatch');
                await state.register(evidence); send('delivered', evidence);
                await state.update({ assetTaskId: evidence.taskId });
              }
              if (code !== 0) throw new Error('Agent failed; inspect private receipt before any further action');
              await state.update({ status: 'completed', finalAnswer: receipt.finalAnswer });
              send(receipt.toolResult ? 'complete' : 'answer', { answer: receipt.finalAnswer });
            }
          } catch {
            await state.update({ status: 'ambiguous', message: 'Execution needs human reconciliation. Inspect private receipt; never automatically retry.' }).catch(() => {});
            send('failed', { error: 'Execution needs human reconciliation. Inspect private receipt; no automatic retry.' });
          } finally { res.end(); }
        });
        return true;
      }
      return json(404, { error: 'Not found' });
    } catch {
      if (!res.headersSent) return json(400, { error: 'Request could not be processed. No automatic retry.' });
      res.end(); return true;
    }
  };
}
