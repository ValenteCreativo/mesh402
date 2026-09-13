import test from "node:test";
import assert from "node:assert/strict";
import { assertPaymentSafety, createMesh402Tool, selectToolCall, validateArguments } from "./mesh402-tool.js";

const requirement = { scheme: "exact", network: "hedera:testnet" as const, amount: "100000",
  asset: "0.0.0", payTo: "0.0.123", maxTimeoutSeconds: 120, extra: { feePayer: "0.0.456" } };
const call = { id: "test", type: "function", function: { name: "generate_3d_asset", arguments: '{"prompt":"a robot"}' } };

test("arguments reject extra fields, blank prompts and oversized prompts", () => {
  for (const value of [null, [], {}, { prompt: " " }, { prompt: "a", recipient: "0.0.999" }, { prompt: "a".repeat(2001) }]) {
    assert.throws(() => validateArguments(value));
  }
  assert.deepEqual(validateArguments({ prompt: " a robot " }), { prompt: "a robot" });
});

test("model can answer without a tool; multiple or unknown calls are rejected", () => {
  assert.equal(selectToolCall(undefined), null);
  assert.equal(selectToolCall([]), null);
  assert.equal(selectToolCall([call])?.args.prompt, "a robot");
  assert.throws(() => selectToolCall([call, call]), /At most one/);
  assert.throws(() => selectToolCall([{ ...call, function: { ...call.function, name: "other" } }]), /Unsupported/);
});

test("exact spend guard rejects every changed payment field before parsing the key or signing", async () => {
  assertPaymentSafety(requirement, requirement.payTo);
  const fetchOriginal = globalThis.fetch;
  try {
    for (const change of [{ network: "hedera:mainnet" }, { amount: "100001" }, { amount: 100000 },
      { payTo: "0.0.999" }, { asset: "0.0.789" }, { scheme: "upto" }]) {
      let requests = 0;
      const required = { x402Version: 2, accepts: [{ ...requirement, ...change }] };
      globalThis.fetch = async () => {
        requests++;
        return Response.json(required, { status: 402, headers: {
          "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(required)).toString("base64"),
        } });
      };
      const invoke = createMesh402Tool({ endpoint: "http://local-test.invalid", payer: "0.0.789",
        recipient: requirement.payTo, privateKey: "invalid-key-must-never-be-parsed",
        expectedRequirements: requirement });
      await assert.rejects(invoke({ prompt: "a robot" }), /Payment safety guard/);
      await assert.rejects(invoke({ prompt: "a robot" }), /Single-tool-call limit/);
      assert.equal(requests, 1, "no signed retry or second attempt");
    }
  } finally { globalThis.fetch = fetchOriginal; }
});

test("concurrent invocations cannot create a second request", async () => {
  const fetchOriginal = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; return Response.json({ error: "mock failure" }, { status: 500 }); };
  try {
    const invoke = createMesh402Tool({ endpoint: "http://local-test.invalid", payer: "0.0.789",
      recipient: requirement.payTo, privateKey: "unused", expectedRequirements: requirement });
    const first = invoke({ prompt: "robot" });
    await assert.rejects(invoke({ prompt: "robot" }), /Single-tool-call limit/);
    await assert.rejects(first, /initial HTTP 500/);
    assert.equal(requests, 1);
  } finally { globalThis.fetch = fetchOriginal; }
});
