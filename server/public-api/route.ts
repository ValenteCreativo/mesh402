import type { IncomingMessage, ServerResponse } from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { inspectHederaTransaction } from '@x402/hedera';
import { discoverRequirements, facilitatorRequest, encode, decode, NETWORK, AMOUNT } from '../../src/x402/server.js';
import { generateAsset } from '../../src/tripo/client.js';
import { persistGlb } from '../../src/tripo/persist.js';
import { publicQuota } from './quota.js';

const defaults = { discover: discoverRequirements, facilitator: facilitatorRequest,
  inspect: inspectHederaTransaction, generate: generateAsset, persist: persistGlb };
export type PublicDependencies = typeof defaults;
export type PublicConfig = { enabled: boolean; origin: string; recipient: string; dataDir: string;
  maxGenerations: number; maxConcurrent: number; providerReady: boolean };
const taskPattern = /^[a-f0-9-]{36}$/;
/** Caller-funded only. No signer, operator-session dependency or payer-key configuration. */
export async function createPublicApi(config: PublicConfig, deps: PublicDependencies = defaults) {
  if (!Number.isSafeInteger(config.maxGenerations) || config.maxGenerations < 0 || config.maxConcurrent !== 1) throw new Error('Public API requires a nonnegative integer quota and MAX_CONCURRENT=1');
  const quota = await publicQuota(resolve(config.dataDir, 'public-api'), config.maxGenerations);
  const url = `${config.origin}/api/v1/generate`;
  let cached: Awaited<ReturnType<typeof deps.discover>> | undefined, expiry = 0;
  let discovering: Promise<Awaited<ReturnType<typeof deps.discover>>> | undefined;
  async function requirements() {
    if (cached && Date.now() < expiry) return cached;
    if (!discovering) discovering = deps.discover(config.recipient).then(value => {
      if (value.scheme !== 'exact' || value.network !== NETWORK || value.amount !== AMOUNT || value.asset !== '0.0.0' || value.payTo !== config.recipient) throw new Error('Unsupported facilitator requirements');
      cached = value; expiry = Date.now() + 60_000; return value;
    }).finally(() => { discovering = undefined; });
    return discovering;
  }
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const path = new URL(req.url ?? '/', config.origin).pathname;
    if (!path.startsWith('/api/v1/')) return false;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'PAYMENT-REQUIRED, PAYMENT-RESPONSE');
    res.setHeader('Cache-Control', 'no-store');
    const reply = (status: number, value: unknown) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); return true; };
    const error = (status: number, code: string, extra = {}) => reply(status, { error: { code }, ...extra });
    const unavailable = (code: string) => error(code === 'quota_exhausted' ? 429 : 409, code);
    try {
      const fileMatch = path.match(/^\/api\/v1\/(assets|receipts)\/([a-f0-9-]{36})\.(glb|json)$/);
      if (fileMatch && ['GET', 'HEAD'].includes(req.method ?? '')) {
        const result = quota.snapshot().assets[fileMatch[2]];
        if (!result || (fileMatch[1] === 'assets') !== (fileMatch[3] === 'glb')) return error(404, 'asset_not_registered');
        if (fileMatch[1] === 'receipts') return reply(200, result);
        const file = resolve(config.dataDir, `${fileMatch[2]}.glb`), info = await stat(file);
        res.setHeader('Content-Type', 'model/gltf-binary'); res.setHeader('Content-Length', info.size);
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        if (req.method === 'HEAD') res.end(); else createReadStream(file).on('error', () => res.destroy()).pipe(res);
        return true;
      }
      if (path !== '/api/v1/generate') return error(404, 'not_found');
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, PAYMENT-SIGNATURE'); res.writeHead(204); res.end(); return true;
      }
      if (req.method !== 'POST') return error(405, 'method_not_allowed');
      if (!config.enabled) return error(503, 'public_api_disabled');
      if (!config.providerReady || !/^0\.0\.[1-9]\d*$/.test(config.recipient)) return error(503, 'public_api_not_configured');
      if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') return error(415, 'json_required');
      let input;
      try {
        let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 16384) return error(413, 'body_too_large'); }
        input = JSON.parse(raw);
        if (!input || Object.keys(input).length !== 1 || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 2000) return error(400, 'invalid_prompt');
      } catch { return error(400, 'invalid_json'); }
      const blocked = quota.availability(); if (blocked) return unavailable(blocked);
      let accepted;
      try { accepted = await requirements(); } catch { return error(503, 'facilitator_unavailable'); }
      const required = { x402Version: 2, resource: { url, description: 'Caller-paid Mesh402 Tripo GLB generation', mimeType: 'application/json' }, accepts: [accepted] };
      const paymentRequired = (reason?: string) => {
        const body = reason ? { ...required, error: reason } : required;
        res.setHeader('PAYMENT-REQUIRED', encode(body)); return reply(402, body);
      };
      const signature = req.headers['payment-signature'];
      if (!signature) return paymentRequired();
      let payment, inspected;
      try {
        if (typeof signature !== 'string' || signature.length > 16000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) return error(400, 'malformed_payment');
        payment = decode(signature);
        if (payment?.x402Version !== 2 || !isDeepStrictEqual(payment.accepted, accepted) || typeof payment.payload?.transaction !== 'string' || !payment.payload.transaction) return error(400, 'payment_requirements_mismatch');
        if (payment.resource?.url !== url) return error(400, 'payment_resource_mismatch');
        inspected = deps.inspect(payment.payload.transaction);
        const debits = inspected.hbarTransfers.filter(t => BigInt(t.amount) < 0n);
        const credits = inspected.hbarTransfers.filter(t => BigInt(t.amount) > 0n);
        if (inspected.hasNonTransferOperations || Object.keys(inspected.tokenTransfers).length ||
          inspected.transactionIdAccountId !== accepted.extra.feePayer || !inspected.transactionId ||
          inspected.hbarTransfers.length !== 2 || debits.length !== 1 || credits.length !== 1 ||
          debits[0].amount !== `-${AMOUNT}` || credits[0].amount !== AMOUNT || credits[0].accountId !== config.recipient || debits[0].accountId === config.recipient) return error(400, 'payment_transfer_mismatch');
      } catch { return error(400, 'malformed_payment'); }
      const claim = await quota.claim(inspected.transactionId); if (claim) return unavailable(claim);
      let paid: boolean | 'unknown' = false;
      try {
        const facilitatorBody = { x402Version: 2, paymentPayload: payment, paymentRequirements: accepted };
        const verification = await deps.facilitator('/verify', facilitatorBody);
        const payer = inspected.hbarTransfers.find(t => t.amount === `-${AMOUNT}`)!.accountId;
        if (verification.isValid !== true || verification.payer !== payer) { await quota.rejected(); return paymentRequired('payment_verification_failed'); }
        await quota.phase('settling'); paid = 'unknown';
        const settlement = await deps.facilitator('/settle', facilitatorBody);
        if (settlement.success !== true || settlement.network !== NETWORK || settlement.transaction !== inspected.transactionId || settlement.payer !== payer) throw new Error('Ambiguous settlement');
        paid = true;
        const receipt = { success: true, network: NETWORK, transaction: settlement.transaction, payer };
        res.setHeader('PAYMENT-RESPONSE', encode(receipt));
        await quota.phase('creating_task');
        let creationWrite: Promise<void> | undefined;
        let creationError: unknown;
        const asset = await deps.generate(input.prompt.trim(), {
          onResponse: (path, envelope) => {
            if (path !== '/generation/text-to-model') return;
            const taskId = (envelope.data as any)?.task_id;
            if (envelope.code !== 0 || typeof taskId !== 'string' || !taskPattern.test(taskId) || creationWrite) throw new Error('Unexpected creation response');
            creationWrite = quota.created(taskId);
            void creationWrite.catch(e => { creationError = e; });
          },
        });
        if (!creationWrite) throw new Error('No observed task creation');
        await creationWrite; if (creationError) throw creationError;
        if (!taskPattern.test(asset.taskId)) throw new Error('Invalid task ID');
        await quota.phase('persisting_asset');
        const file = await deps.persist(asset);
        const result = { status: 'success', network: NETWORK, price: '0.001 HBAR', amountTinybars: AMOUNT,
          transactionId: settlement.transaction, payer, recipient: config.recipient, verificationValid: true, settlementSuccess: true,
          taskId: asset.taskId, assetUrl: `${config.origin}/api/v1/assets/${asset.taskId}.glb`,
          receiptUrl: `${config.origin}/api/v1/receipts/${asset.taskId}.json`, creditsConsumed: asset.consumedCredit ?? null,
          glbBytes: file.glbBytes, prompt: input.prompt.trim() };
        await quota.complete(asset.taskId, result);
        return reply(200, result);
      } catch {
        await quota.ambiguous().catch(() => {});
        return error(502, 'execution_requires_reconciliation', { paid, transactionId: inspected.transactionId, taskId: quota.snapshot().active?.taskId ?? null, retryable: false });
      }
    } catch { return error(503, 'public_api_unavailable'); }
  };
}
