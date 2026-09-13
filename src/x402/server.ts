import { createServer } from "node:http";
import { once } from "node:events";
import { isDeepStrictEqual } from "node:util";
import type { PaymentRequirements, PaymentRequired } from "@x402/core/types";
import { generateAsset } from "../tripo/client.js";
import { persistGlb } from "../tripo/persist.js";

export const FACILITATOR = "https://api.testnet.blocky402.com";
export const NETWORK = "hedera:testnet";
export const AMOUNT = "100000"; // tinybars: exactly 0.001 HBAR
export const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");
export const decode = (value: string) => JSON.parse(Buffer.from(value, "base64").toString("utf8"));

export async function facilitatorRequest(path: string, body?: unknown) {
  const response = await fetch(`${FACILITATOR}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(90_000),
    redirect: "error",
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Blocky402 ${path} HTTP ${response.status}: ${text}`);
  try { return JSON.parse(text); } catch { throw new Error(`Blocky402 ${path} returned non-JSON: ${text}`); }
}

export async function discoverRequirements(payTo: string): Promise<PaymentRequirements> {
  const supported = await facilitatorRequest("/supported");
  const kind = supported.kinds?.find((entry: any) =>
    entry.x402Version === 2 && entry.scheme === "exact" && entry.network === NETWORK);
  const feePayer = kind?.extra?.feePayer ?? supported.signers?.["hedera:*"]?.[0];
  if (!kind || typeof feePayer !== "string" || !/^0\.0\.\d+$/.test(feePayer)) {
    throw new Error(`Blocky402 lacks Hedera testnet v2 exact support or feePayer: ${JSON.stringify(supported)}`);
  }
  return { scheme: "exact", network: NETWORK, amount: AMOUNT, asset: "0.0.0",
    payTo, maxTimeoutSeconds: 120, extra: { feePayer } };
}

/** One-shot loopback spike: at most one verification/settlement attempt per process. */
export async function startPaymentServer(requirements: PaymentRequirements) {
  let attempted = false;
  const evidence: { verification?: any; settlement?: any; tripoCreation?: any; tripoFinal?: any; generationMs?: number } = {};
  let url = "";
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    const reply = (status: number, body: unknown) => {
      response.statusCode = status;
      response.end(JSON.stringify(body));
    };
    if (request.method !== "POST" || request.url !== "/api/generate-3d") {
      reply(404, { error: "Not found" }); return;
    }
    let prompt: string;
    try {
      if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") {
        request.resume(); reply(415, { error: "Content-Type must be application/json" }); return;
      }
      let raw = "";
      for await (const chunk of request) {
        raw += chunk.toString("utf8");
        if (Buffer.byteLength(raw) > 16_384) { reply(413, { error: "Request body too large" }); return; }
      }
      const input = JSON.parse(raw);
      if (typeof input?.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 2000) {
        reply(400, { error: "prompt must be a nonempty string of at most 2000 characters" }); return;
      }
      prompt = input.prompt.trim();
    } catch { reply(400, { error: "Invalid JSON request body" }); return; }
    const required: PaymentRequired = { x402Version: 2,
      resource: { url, description: "Agent-native 3D infrastructure: paid Tripo generation", mimeType: "application/json" },
      accepts: [requirements] };
    const signature = request.headers["payment-signature"];
    if (!signature) {
      response.setHeader("PAYMENT-REQUIRED", encode(required));
      reply(402, required); return;
    }
    try {
      if (typeof signature !== "string") { reply(400, { error: "Invalid PAYMENT-SIGNATURE" }); return; }
      let payment;
      try { payment = decode(signature); } catch { reply(400, { error: "Malformed PAYMENT-SIGNATURE" }); return; }
      if (payment?.x402Version !== 2 || !isDeepStrictEqual(payment.accepted, requirements) ||
          typeof payment.payload?.transaction !== "string" || !payment.payload.transaction) {
        reply(400, { error: "Payment does not match server requirements" }); return;
      }
      if (attempted) { reply(409, { error: "This one-shot spike already attempted a payment" }); return; }
      attempted = true;
      const body = { x402Version: 2, paymentPayload: payment, paymentRequirements: requirements };
      evidence.verification = await facilitatorRequest("/verify", body);
      console.log("verification:", JSON.stringify(evidence.verification));
      if (evidence.verification.isValid !== true) {
        reply(402, { error: "Blocky402 verification failed", verification: evidence.verification }); return;
      }
      evidence.settlement = await facilitatorRequest("/settle", body);
      console.log("settlement:", JSON.stringify(evidence.settlement));
      if (evidence.settlement.success !== true) {
        reply(402, { error: "Blocky402 settlement failed", settlement: evidence.settlement }); return;
      }
      if (evidence.settlement.network !== NETWORK || typeof evidence.settlement.transaction !== "string" || !evidence.settlement.transaction) {
        reply(502, { error: "Unexpected settlement receipt", settlement: evidence.settlement }); return;
      }
      response.setHeader("PAYMENT-RESPONSE", encode(evidence.settlement));
      const generationStarted = Date.now();
      const asset = await generateAsset(prompt, {
        onProgress: (progress, status) => console.log("tripoProgress:", JSON.stringify({ progress, status })),
        onResponse: (path, envelope) => {
          if (path === "/generation/text-to-model") {
            evidence.tripoCreation = envelope;
            console.log("tripoCreation:", JSON.stringify(envelope));
          } else { evidence.tripoFinal = envelope; }
        },
      });
      evidence.generationMs = Date.now() - generationStarted;
      const persisted = await persistGlb(asset);
      reply(200, { paid: true, network: NETWORK, paymentAmount: "0.001 HBAR",
        transactionId: evidence.settlement.transaction, tripoTaskId: asset.taskId,
        status: "success", modelUrl: asset.glbUrl, previewUrl: asset.previewUrl ?? null,
        ...persisted, creditsConsumed: asset.consumedCredit ?? null });
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error);
      for (const [name, value] of Object.entries(process.env)) {
        if (value && /KEY|SECRET|TOKEN/.test(name)) message = message.split(value).join("[REDACTED]");
      }
      reply(502, { error: message, paid: evidence.settlement?.success === true,
        settlement: evidence.settlement, tripoCreation: evidence.tripoCreation });
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  url = `http://127.0.0.1:${address.port}/api/generate-3d`;
  return { url, evidence, close: () => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeIdleConnections();
  }) };
}
