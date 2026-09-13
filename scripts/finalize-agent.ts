import assert from "node:assert/strict";
import { readFile, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { AGENT_SYSTEM_PROMPT, finalizeResponse, assertFinalResponse } from "../src/agent/finalize.js";

// Reads saved evidence only. No imports from payment, signing, Tripo, or tool modules.
async function main() {
  const path = resolve("generated", "mesh402-agent-receipt.json");
  const receipt = JSON.parse(await readFile(path, "utf8"));
  assert.equal(receipt.mode, "live");
  assert.equal(receipt.toolInvocations, 1);
  assert.equal(receipt.decision?.tool, "generate_3d_asset");
  assert.equal(receipt.toolResult?.finalHttpStatus, 200);
  assert.equal(receipt.toolResult?.settlement?.success, true);
  assert.equal(receipt.toolResult?.asset?.status, "success");
  assert.equal(receipt.serviceEvidence?.tripoFinal?.data?.status, "success");
  const originalEvidence = JSON.stringify({ toolResult: receipt.toolResult, serviceEvidence: receipt.serviceEvidence,
    toolInvocations: receipt.toolInvocations });
  // Older receipts saved the request/arguments/result but not the original call ID.
  const recoveredCallId = "recovered_generate_3d_asset";
  const messages = receipt.messages ?? [
    { role: "system", content: AGENT_SYSTEM_PROMPT },
    { role: "user", content: receipt.request },
    { role: "assistant", content: null, tool_calls: [{ id: recoveredCallId, type: "function",
      function: { name: receipt.decision.tool, arguments: JSON.stringify(receipt.decision.arguments) } }] },
    { role: "tool", tool_call_id: recoveredCallId, content: JSON.stringify(receipt.toolResult) },
  ];
  const attempt: Record<string, unknown> = { startedAt: new Date().toISOString(),
    conversationReconstructed: !receipt.messages, additionalToolExecutions: 0, additionalPayments: 0, additionalGenerations: 0 };
  try {
    const result = await finalizeResponse(messages);
    Object.assign(attempt, result);
    console.log("finalizationMetadata:", JSON.stringify({ finishReason: result.finishReason,
      truncated: result.truncated, usage: result.usage, toolsEnabled: result.toolsEnabled }));
    assertFinalResponse(result);
    receipt.finalAnswer = result.message.content;
    receipt.status = "success";
    if (receipt.error) { receipt.previousError = receipt.error; delete receipt.error; }
    console.log(result.message.content);
  } catch (error) {
    attempt.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    receipt.finalizationAttempts ??= [];
    receipt.finalizationAttempts.push(attempt);
    assert.equal(JSON.stringify({ toolResult: receipt.toolResult, serviceEvidence: receipt.serviceEvidence,
      toolInvocations: receipt.toolInvocations }), originalEvidence);
    await writeFile(`${path}.tmp`, JSON.stringify(receipt, null, 2));
    await rename(`${path}.tmp`, path);
    console.log("agentReceipt:", path);
  }
}

main().catch(error => {
  const key = process.env.NEBIUS_API_KEY?.trim();
  const message = error instanceof Error ? error.message : String(error);
  console.error(key ? message.split(key).join("[REDACTED]") : message);
  process.exitCode = 1;
});
