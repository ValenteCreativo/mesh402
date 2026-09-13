import assert from "node:assert/strict";
import { mkdir, writeFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { createClientHederaSigner, PrivateKey, inspectHederaTransaction } from "@x402/hedera";
import { AMOUNT, NETWORK, decode, encode, discoverRequirements, startPaymentServer } from "../src/x402/server.js";

function env(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required in .env.local`);
  return value;
}

async function main() {
  const started = Date.now();
  const prompt = "low-poly cyberpunk arcade machine, game-ready, clean stylized geometry";
  env("TRIPO_API_KEY");
  const payer = env("HEDERA_PAYER_ACCOUNT_ID");
  const recipient = env("HEDERA_PAY_TO_ACCOUNT_ID");
  assert.match(payer, /^0\.0\.[1-9]\d*$/);
  assert.match(recipient, /^0\.0\.[1-9]\d*$/);
  assert.notEqual(payer, recipient, "Payer and recipient must differ");
  let key: PrivateKey;
  try { key = PrivateKey.fromStringECDSA(env("HEDERA_PAYER_PRIVATE_KEY")); }
  catch { throw new Error("HEDERA_PAYER_PRIVATE_KEY is missing or is not a valid ECDSA private key (value withheld)"); }
  const requirements = await discoverRequirements(recipient);
  const service = await startPaymentServer(requirements);
  try {
    const requestBody = JSON.stringify({ prompt });
    const initial = await fetch(service.url, { method: "POST", headers: { "Content-Type": "application/json" },
      body: requestBody, signal: AbortSignal.timeout(10_000) });
    console.log("initialHttpStatus:", initial.status);
    assert.equal(initial.status, 402);
    const required = decode(initial.headers.get("PAYMENT-REQUIRED") ?? "");
    assert.deepEqual(await initial.json(), required);
    assert.equal(required.x402Version, 2);
    assert.equal(required.accepts.length, 1);
    const accepted = required.accepts[0];
    assert.deepEqual(accepted, requirements);
    assert.equal(accepted.amount, AMOUNT);
    assert.equal(accepted.network, NETWORK);
    assert.equal(accepted.payTo, recipient);
    assert.equal(accepted.asset, "0.0.0");
    const signer = createClientHederaSigner(payer, key, { network: NETWORK });
    const signed = await new ExactHederaScheme(signer).createPaymentPayload(2, accepted);
    const inspected = inspectHederaTransaction(signed.payload.transaction as string);
    assert.equal(inspected.hasNonTransferOperations, false);
    assert.deepEqual(inspected.tokenTransfers, {});
    assert.equal(inspected.transactionIdAccountId, requirements.extra.feePayer);
    assert.deepEqual([...inspected.hbarTransfers].sort((a, b) => a.accountId.localeCompare(b.accountId)),
      [{ accountId: payer, amount: `-${AMOUNT}` }, { accountId: recipient, amount: AMOUNT }]
        .sort((a, b) => a.accountId.localeCompare(b.accountId)));
    console.log("signedPayment:", JSON.stringify({ network: NETWORK, amount: AMOUNT, unit: "tinybar", payer, recipient, transactionId: inspected.transactionId }));
    const payment = { x402Version: 2, resource: required.resource, accepted, payload: signed.payload };
    // Exactly one signed retry. Settlement precedes generation and GLB persistence.
    const final = await fetch(service.url, { method: "POST",
      headers: { "PAYMENT-SIGNATURE": encode(payment), "Content-Type": "application/json" },
      body: requestBody, signal: AbortSignal.timeout(600_000) });
    const response = await final.json();
    if (final.status !== 200) throw new Error(`Protected retry HTTP ${final.status}: ${JSON.stringify(response)}`);
    const settlement = decode(final.headers.get("PAYMENT-RESPONSE") ?? "");
    assert.equal(settlement.success, true);
    assert.equal(settlement.network, NETWORK);
    assert.equal(settlement.payer, payer);
    assert.equal(response.paid, true);
    assert.equal(response.status, "success");
    assert.equal(response.network, NETWORK);
    assert.equal(response.paymentAmount, "0.001 HBAR");
    assert.equal(response.transactionId, settlement.transaction);
    assert.equal(response.tripoTaskId, service.evidence.tripoCreation.data.task_id);
    assert.equal(service.evidence.tripoFinal.data.status, "success");
    assert.equal(response.modelUrl, service.evidence.tripoFinal.data.output.model_url);
    assert.equal(response.creditsConsumed, service.evidence.tripoFinal.data.credits_consumed ?? null);
    assert.equal((await stat(response.localGlbPath)).size, response.glbBytes);
    const receipt = { initialHttpStatus: initial.status, amount: "0.001 HBAR", amountTinybars: AMOUNT,
      network: NETWORK, payer, recipient, verification: service.evidence.verification, settlement,
      signedTransactionId: inspected.transactionId, finalHttpStatus: final.status, response,
      prompt, tripoCreation: service.evidence.tripoCreation, tripoFinal: service.evidence.tripoFinal,
      generationMs: service.evidence.generationMs, elapsedMs: Date.now() - started };
    await mkdir(resolve("generated"), { recursive: true });
    const receiptPath = resolve("generated", "mesh402-e2e-receipt.json");
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2));
    console.log("receipt:", JSON.stringify({ ...receipt, receiptPath }, null, 2));
  } finally { await service.close(); }
}

main().catch(error => {
  let message = error instanceof Error ? error.message : String(error);
  for (const [name, value] of Object.entries(process.env)) {
    if (value && /KEY|SECRET|TOKEN/.test(name)) {
      message = message.split(value).join("[REDACTED]");
      if (value.startsWith("0x")) message = message.split(value.slice(2)).join("[REDACTED]");
    }
  }
  console.error(message);
  process.exitCode = 1;
});
