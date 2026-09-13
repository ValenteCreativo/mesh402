import type { Plugin, Connect } from 'vite';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const root = fileURLToPath(new URL('..', import.meta.url));
const receiptPath = resolve(root, 'generated/mesh402-agent-receipt.json');
const replayPath = resolve(root, 'generated/mesh402-verified-demo.json');
const heroTask = 'fb48a85c-ac6c-4d25-8ba0-641c2089df24';

function publicEvidence(r: any) {
  const result = r.toolResult;
  if (result?.finalHttpStatus !== 200 || result.asset?.status !== 'success') throw new Error('No delivered asset in this receipt');
  const a = result.asset;
  return {
    request: r.request, tool: r.decision.tool, prompt: r.decision.arguments.prompt,
    model: r.model, initialHttpStatus: result.initialHttpStatus, finalHttpStatus: result.finalHttpStatus,
    network: a.network, amount: a.paymentAmount, payer: result.settlement.payer,
    recipient: r.recipient ?? null,
    transactionId: result.settlement.transaction, verified: r.serviceEvidence.verification.isValid,
    settled: result.settlement.success, taskId: a.tripoTaskId, credits: a.creditsConsumed,
    bytes: a.glbBytes, assetUrl: `/demo/assets/${a.tripoTaskId}.glb`,
    finalAnswer: r.finalAnswer ?? null, finalizationRecovered: !!r.previousError,
    generationMs: r.serviceEvidence.generationMs,
    createdAt: r.serviceEvidence.tripoFinal.data.created_at,
    completedAt: r.serviceEvidence.tripoFinal.data.completed_at,
    hashscan: `https://hashscan.io/testnet/transaction/${encodeURIComponent(a.transactionId)}`,
  };
}

export function demoBridge(): Plugin {
  let replay: ReturnType<typeof publicEvidence>;
  let liveAttempted = false;
  const liveIds = new Set<string>();
  async function loadReplay() {
    let raw;
    try { raw = JSON.parse(await readFile(replayPath, 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      raw = JSON.parse(await readFile(receiptPath, 'utf8'));
      if (raw.toolResult?.asset?.tripoTaskId !== heroTask) throw new Error('Original agent receipt is required to preserve demo evidence');
      await writeFile(replayPath, JSON.stringify(raw, null, 2), { flag: 'wx' });
    }
    replay = publicEvidence(raw);
    if (replay.taskId !== heroTask) throw new Error('Expected the verified street food cart agent receipt');
    // The agent receipt omitted recipient. Recover the same configured account pair
    // from the prior successful E2E receipt (also confirmed in the user's demo brief).
    const earlier = JSON.parse(await readFile(resolve(root, 'generated/mesh402-e2e-receipt.json'), 'utf8'));
    if (earlier.payer !== replay.payer) throw new Error('Demo payer evidence mismatch');
    replay.recipient = earlier.recipient;
    const file = await stat(resolve(root, 'generated', `${heroTask}.glb`));
    if (file.size !== replay.bytes) throw new Error('Hero GLB size does not match the receipt');
  }
  function middleware(): Connect.NextHandleFunction {
    return async (req, res, next) => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (!path.startsWith('/demo/')) return next();
      const json = (status: number, value: unknown) => {
        res.statusCode = status; res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(value));
      };
      try {
        if (path === '/demo/evidence' && req.method === 'GET') return json(200, replay);
        if (path === '/demo/receipt' && req.method === 'GET') {
          res.setHeader('Content-Disposition', 'attachment; filename="mesh402-verified-run.json"');
          return json(200, replay); // Public fields only, not private filesystem paths or signed URLs.
        }
        const asset = path.match(/^\/demo\/assets\/([a-f0-9-]{36})\.glb$/);
        if (asset && (req.method === 'GET' || req.method === 'HEAD')) {
          if (asset[1] !== heroTask && !liveIds.has(asset[1])) return json(404, { error: 'Unknown asset' });
          const file = resolve(root, 'generated', `${asset[1]}.glb`);
          const info = await stat(file);
          res.setHeader('Content-Type', 'model/gltf-binary');
          res.setHeader('Content-Length', info.size);
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          if (req.method === 'HEAD') return res.end();
          createReadStream(file).on('error', () => res.destroy()).pipe(res); return;
        }
        if (path === '/demo/live' && req.method === 'POST') {
          // Local demo control only. A cross-origin page cannot start a paid run.
          if (req.headers.origin !== `http://${req.headers.host}`) return json(403, { error: 'Same-origin request required' });
          if (liveAttempted) return json(409, { error: 'One live attempt per server session. Restart manually to authorize another.' });
          let raw = '';
          for await (const chunk of req) { raw += chunk; if (raw.length > 12000) return json(413, { error: 'Request too large' }); }
          const body = JSON.parse(raw);
          if (body.confirm !== true || typeof body.intent !== 'string' || !body.intent.trim() || body.intent.length > 2000) {
            return json(400, { error: 'An intent and explicit payment confirmation are required' });
          }
          liveAttempted = true;
          const previousReceipt = await readFile(receiptPath, 'utf8');
          res.setHeader('Content-Type', 'application/x-ndjson');
          res.setHeader('Cache-Control', 'no-store');
          res.flushHeaders();
          const send = (event: string, data: unknown) => { if (!res.destroyed) res.write(JSON.stringify({ event, data }) + '\n'); };
          send('started', {});
          const child = spawn(process.execPath, ['--env-file=.env.local', '--import', 'tsx', 'scripts/test-agent.ts', '--live', body.intent], {
            cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
          });
          let liveRecipient: string | null = null;
          const safeEvents: Record<string, string> = { toolSelection: 'tool', signedPayment: 'signed', verification: 'verified', settlement: 'settled', tripoCreation: 'created', tripoProgress: 'progress' };
          createInterface({ input: child.stdout }).on('line', line => {
            const marker = line.indexOf(': ');
            const event = safeEvents[line.slice(0, marker)];
            if (event) { try {
              const data = JSON.parse(line.slice(marker + 2));
              if (event === 'signed' && typeof data.recipient === 'string') liveRecipient = data.recipient;
              send(event, data);
            } catch { /* Non-event output is not exposed. */ } }
          });
          child.stderr.resume(); // Receipt carries sanitized errors; never proxy raw process output.
          child.on('error', () => { send('failed', { error: 'Could not start the existing agent CLI. No automatic retry.' }); res.end(); });
          child.on('close', async code => {
            try {
              const saved = await readFile(receiptPath, 'utf8');
              if (saved === previousReceipt) throw new Error('No new execution receipt was produced. Previous results will not be presented as live.');
              const receipt = JSON.parse(saved);
              if (receipt.request !== body.intent) throw new Error('Agent did not produce a matching receipt');
              if (receipt.toolResult?.asset?.status === 'success') {
                const evidence = publicEvidence(receipt);
                evidence.recipient = liveRecipient;
                liveIds.add(evidence.taskId); send('delivered', evidence);
              }
              if (code !== 0) send('failed', { error: receipt.error ?? 'Agent execution failed. No automatic retry.' });
              else if (!receipt.toolResult) send('answer', { answer: receipt.finalAnswer, message: 'Agent answered without spending.' });
              else send('complete', { answer: receipt.finalAnswer });
            } catch (error) { send('failed', { error: error instanceof Error ? error.message : 'Could not read result' }); }
            res.end();
          });
          return;
        }
        json(404, { error: 'Not found' });
      } catch (error) { if (!res.headersSent) json(500, { error: error instanceof Error ? error.message : 'Demo bridge error' }); else res.end(); }
    };
  }
  return {
    name: 'mesh402-local-demo',
    async configureServer(server) { await loadReplay(); server.middlewares.use(middleware()); },
    async configurePreviewServer(server) { await loadReplay(); server.middlewares.use(middleware()); },
  };
}
