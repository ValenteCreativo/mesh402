import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import type { PaymentRequirements } from "@x402/core/types";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { createClientHederaSigner, PrivateKey, inspectHederaTransaction } from "@x402/hedera";
import { decode, encode } from "../x402/server.js";

export const assetTool = {
  type: "function",
  function: {
    name: "generate_3d_asset",
    description: "Purchase a newly generated 3D GLB asset from Mesh402 for 0.001 HBAR on Hedera testnet. Use only when the user needs an actual 3D asset; at most once.",
    parameters: {
      type: "object",
      properties: { prompt: { type: "string", minLength: 1, maxLength: 2000 } },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
} as const;

export function validateArguments(value: unknown): { prompt: string } {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== 1 || !("prompt" in value) ||
      typeof value.prompt !== "string" || !value.prompt.trim() || value.prompt.length > 2000) {
    throw new Error("Tool arguments must contain only a nonempty prompt of at most 2000 characters");
  }
  return { prompt: value.prompt.trim() };
}

export function selectToolCall(calls: unknown) {
  if (calls === undefined || (Array.isArray(calls) && calls.length === 0)) return null;
  if (!Array.isArray(calls) || calls.length !== 1) throw new Error("At most one tool call is allowed; no tools executed");
  const call = calls[0];
  if (call?.type !== "function" || call.function?.name !== "generate_3d_asset" ||
      typeof call.id !== "string" || !call.id || typeof call.function.arguments !== "string") {
    throw new Error("Unsupported or malformed tool call; no tools executed");
  }
  return { call, args: validateArguments(JSON.parse(call.function.arguments)) };
}

/** This guard runs before the private key is parsed or any signer is created. */
export function assertPaymentSafety(value: unknown, recipient: string): asserts value is PaymentRequirements {
  const requirement = value as PaymentRequirements | null;
  if (!/^0\.0\.[1-9]\d*$/.test(recipient) || requirement?.network !== "hedera:testnet" ||
      requirement.amount !== "100000" || requirement.payTo !== recipient ||
      requirement.scheme !== "exact" || requirement.asset !== "0.0.0") {
    throw new Error("Payment safety guard: expected exact hedera:testnet, 100000 tinybars of HBAR, and the configured recipient; aborted before signing");
  }
}

export function redact(text: string) {
  for (const [name, value] of Object.entries(process.env)) {
    if (value && /KEY|SECRET|TOKEN/.test(name)) {
      text = text.split(value).join("[REDACTED]");
      if (value.startsWith("0x")) text = text.split(value.slice(2)).join("[REDACTED]");
    }
  }
  return text;
}

/** One instance per agent execution. Consumes its allowance even on failure. */
export function createMesh402Tool(config: {
  endpoint: string;
  payer: string;
  recipient: string;
  privateKey: string;
  expectedRequirements: PaymentRequirements;
}) {
  let invoked = false;
  return async (input: unknown) => {
    if (invoked) throw new Error("Single-tool-call limit reached; no retry permitted");
    invoked = true; // Set synchronously, before any await, including concurrent calls.
    const args = validateArguments(input);
    assert.match(config.payer, /^0\.0\.[1-9]\d*$/);
    assert.notEqual(config.payer, config.recipient);
    const body = JSON.stringify(args);
    const initial = await fetch(config.endpoint, { method: "POST", headers: { "Content-Type": "application/json" },
      body, redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (initial.status !== 402) throw new Error(`Mesh402 initial HTTP ${initial.status}: ${redact(await initial.text())}`);
    const required = decode(initial.headers.get("PAYMENT-REQUIRED") ?? "");
    assert.deepEqual(await initial.json(), required);
    assert.equal(required.x402Version, 2);
    assert.equal(required.accepts?.length, 1);
    const accepted = required.accepts[0];
    assertPaymentSafety(accepted, config.recipient);
    assert.deepEqual(accepted, config.expectedRequirements); // Includes live Blocky402 fee payer.
    let key: PrivateKey;
    try { key = PrivateKey.fromStringECDSA(config.privateKey); }
    catch { throw new Error("Invalid payer ECDSA private key (value withheld)"); }
    const signer = createClientHederaSigner(config.payer, key, { network: "hedera:testnet" });
    const signed = await new ExactHederaScheme(signer).createPaymentPayload(2, accepted);
    const inspected = inspectHederaTransaction(signed.payload.transaction as string);
    assert.equal(inspected.hasNonTransferOperations, false);
    assert.deepEqual(inspected.tokenTransfers, {});
    assert.equal(inspected.transactionIdAccountId, accepted.extra.feePayer);
    const sort = (a: { accountId: string }, b: { accountId: string }) => a.accountId.localeCompare(b.accountId);
    assert.deepEqual([...inspected.hbarTransfers].sort(sort), [
      { accountId: config.payer, amount: "-100000" }, { accountId: config.recipient, amount: "100000" },
    ].sort(sort));
    console.log("signedPayment:", JSON.stringify({ payer: config.payer, recipient: config.recipient,
      network: accepted.network, amountTinybars: accepted.amount, transactionId: inspected.transactionId }));
    const payment = { x402Version: 2, resource: required.resource, accepted, payload: signed.payload };
    const final = await fetch(config.endpoint, { method: "POST", redirect: "error",
      headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": encode(payment) },
      body, signal: AbortSignal.timeout(600_000) });
    const response = await final.json();
    if (final.status !== 200) throw new Error(`Mesh402 paid retry HTTP ${final.status}: ${redact(JSON.stringify(response))}`);
    const settlement = decode(final.headers.get("PAYMENT-RESPONSE") ?? "");
    assert.equal(settlement.success, true);
    assert.equal(settlement.network, "hedera:testnet");
    assert.equal(settlement.payer, config.payer);
    assert.equal(settlement.transaction, inspected.transactionId);
    assert.equal(response.paid, true);
    assert.equal(response.status, "success");
    assert.equal(response.network, "hedera:testnet");
    assert.equal(response.paymentAmount, "0.001 HBAR");
    assert.equal(response.transactionId, settlement.transaction);
    assert.ok(typeof response.tripoTaskId === "string" && response.tripoTaskId);
    assert.ok(typeof response.modelUrl === "string" && response.modelUrl);
    assert.ok(response.glbBytes > 12);
    assert.equal((await stat(response.localGlbPath)).size, response.glbBytes);
    return { initialHttpStatus: initial.status, finalHttpStatus: final.status, settlement, asset: response };
  };
}
