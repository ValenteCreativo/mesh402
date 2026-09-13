import assert from 'node:assert/strict';
import { ExactHederaScheme } from '@x402/hedera/exact/client';
import { createClientHederaSigner, PrivateKey, inspectHederaTransaction } from '@x402/hedera';
import { decode, encode, discoverRequirements } from '../src/x402/server.js';

// Explicit caller-only environment. Never fall back to HEDERA_PAYER_*.
function required(name: string) { const value = process.env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value; }
async function main() {
  const endpoint = new URL(process.env.MESH402_API_URL ?? 'https://mesh402.onrender.com/api/v1/generate');
  assert.ok(endpoint.protocol === 'https:' || (endpoint.protocol === 'http:' && ['127.0.0.1','localhost'].includes(endpoint.hostname)), 'Use HTTPS except on loopback');
  assert.equal(endpoint.pathname, '/api/v1/generate'); assert.equal(endpoint.search, ''); assert.equal(endpoint.username, ''); assert.equal(endpoint.password, '');
  const payer = required('CALLER_HEDERA_ACCOUNT_ID');
  const keyText = required('CALLER_HEDERA_PRIVATE_KEY');
  assert.match(payer, /^0\.0\.[1-9]\d*$/);
  const prompt = process.argv.slice(2).join(' ').trim() || 'low-poly autonomous delivery robot';
  assert.ok(prompt.length > 0 && prompt.length <= 2000);
  const body = JSON.stringify({ prompt });
  const initial = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, redirect: 'error', signal: AbortSignal.timeout(100_000) });
  console.log('initialHttpStatus:', initial.status);
  if (initial.status !== 402) throw new Error(`API did not offer payment: HTTP ${initial.status}; no payment signed`);
  const offer = decode(initial.headers.get('PAYMENT-REQUIRED') ?? '');
  assert.deepEqual(await initial.json(), offer); assert.equal(offer.x402Version, 2); assert.equal(offer.accepts?.length, 1); assert.equal(offer.resource?.url, endpoint.href);
  const accepted = offer.accepts[0];
  assert.equal(accepted.network, 'hedera:testnet'); assert.equal(accepted.scheme, 'exact'); assert.equal(accepted.amount, '100000'); assert.equal(accepted.asset, '0.0.0');
  assert.match(accepted.payTo, /^0\.0\.[1-9]\d*$/); assert.notEqual(accepted.payTo, payer);
  // Optional caller trust pin; otherwise destination is the selected HTTPS service's advertised account.
  if (process.env.CALLER_EXPECTED_PAY_TO) assert.equal(accepted.payTo, process.env.CALLER_EXPECTED_PAY_TO);
  assert.deepEqual(accepted, await discoverRequirements(accepted.payTo));
  let key: PrivateKey; try { key = PrivateKey.fromStringECDSA(keyText); } catch { throw new Error('Invalid caller ECDSA private key (withheld)'); }
  const signer = createClientHederaSigner(payer, key, { network: 'hedera:testnet' });
  const signed = await new ExactHederaScheme(signer).createPaymentPayload(2, accepted);
  const tx = inspectHederaTransaction(signed.payload.transaction as string);
  assert.equal(tx.hasNonTransferOperations, false); assert.deepEqual(tx.tokenTransfers, {});
  assert.equal(tx.transactionIdAccountId, accepted.extra.feePayer);
  const sort=(a:{accountId:string},b:{accountId:string})=>a.accountId.localeCompare(b.accountId);
  assert.deepEqual([...tx.hbarTransfers].sort(sort), [{accountId:payer,amount:'-100000'},{accountId:accepted.payTo,amount:'100000'}].sort(sort));
  console.log(JSON.stringify({payer,recipient:accepted.payTo,network:accepted.network,amountTinybars:accepted.amount,transactionId:tx.transactionId}));
  const payment = { x402Version: 2, resource: offer.resource, accepted, payload: signed.payload };
  // Exactly one paid retry. Never repeat this POST after a timeout or ambiguous result.
  const final = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'PAYMENT-SIGNATURE': encode(payment) }, body, redirect: 'error', signal: AbortSignal.timeout(600_000) });
  const result = await final.json();
  console.log('finalHttpStatus:', final.status);
  if (final.status !== 200) { console.log(JSON.stringify({errorCode:result.error?.code,paid:result.paid,transactionId:result.transactionId,taskId:result.taskId})); throw new Error('Paid request did not complete. Stop and reconcile; do not retry automatically.'); }
  const settlement = decode(final.headers.get('PAYMENT-RESPONSE') ?? '');
  assert.equal(settlement.success, true); assert.equal(settlement.network, 'hedera:testnet'); assert.equal(settlement.payer, payer); assert.equal(settlement.transaction, tx.transactionId);
  assert.equal(result.status, 'success'); assert.equal(result.transactionId, tx.transactionId); assert.equal(result.payer, payer);
  const assetUrl = new URL(result.assetUrl); assert.equal(assetUrl.origin, endpoint.origin); assert.equal(assetUrl.pathname, `/api/v1/assets/${result.taskId}.glb`);
  console.log(JSON.stringify(result, null, 2));
}
main().catch(error => {
  // Do not echo provider bodies or private-key parser errors.
  let message = error instanceof Error ? error.message : 'External client failed';
  for (const [name,value] of Object.entries(process.env)) if (value && /KEY|SECRET|TOKEN/.test(name)) message = message.split(value).join('[REDACTED]');
  console.error(message); process.exitCode = 1;
});
