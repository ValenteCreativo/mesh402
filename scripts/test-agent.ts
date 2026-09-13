import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assetTool, createMesh402Tool, redact, selectToolCall } from "../src/agent/mesh402-tool.js";
import { discoverRequirements, startPaymentServer } from "../src/x402/server.js";

function env(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required in .env.local`);
  return value;
}

async function main() {
  const flags = process.argv.slice(2);
  if (flags.some(arg => arg.startsWith("--") && !["--live", "--dry-run"].includes(arg)) ||
      (flags.includes("--live") && flags.includes("--dry-run"))) throw new Error("Use --dry-run (default) OR --live followed by a natural-language request");
  const live = flags.includes("--live");
  const request = flags.filter(arg => !arg.startsWith("--")).join(" ").trim();
  if (!request) throw new Error("Provide a natural-language request after --dry-run or --live");
  const model = env("NEBIUS_MODEL");
  const baseUrl = env("NEBIUS_BASE_URL").replace(/\/$/, "");
  const key = env("NEBIUS_API_KEY");
  if (new URL(baseUrl).protocol !== "https:") throw new Error("NEBIUS_BASE_URL must use HTTPS");
  const messages: Record<string, unknown>[] = [
    { role: "system", content: "You consume Mesh402, agent-native 3D infrastructure. Decide whether the user's request needs an actual newly generated 3D asset. If yes, you may call generate_3d_asset once, costing 0.001 HBAR on Hedera testnet. If not, answer without tools or spending. Never call more than one tool. Use the tool result as evidence; never invent successful payment, generation, URLs, or local paths. If a result says dryRun, clearly state that nothing was purchased or generated." },
    { role: "user", content: request },
  ];
  const receipt: Record<string, unknown> = { mode: live ? "live" : "dry-run", model, request,
    toolInvocations: 0, status: "started" };
  let service: Awaited<ReturnType<typeof startPaymentServer>> | undefined;
  async function completion(allowTool: boolean) {
    const response = await fetch(`${baseUrl}/chat/completions`, { method: "POST", redirect: "error",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, max_tokens: 1000,
        ...(allowTool ? { tools: [assetTool], tool_choice: "auto" } : {}) }),
      signal: AbortSignal.timeout(90_000) });
    const text = redact(await response.text());
    if (!response.ok) throw new Error(`Nebius HTTP ${response.status}: ${text}`);
    const parsed = JSON.parse(text);
    if (parsed.choices?.[0]?.finish_reason === "length") throw new Error("Nebius response was truncated; no further execution");
    const message = parsed.choices?.[0]?.message;
    if (message?.role !== "assistant") throw new Error(`Unexpected Nebius response: ${text}`);
    return message;
  }
  try {
    console.log(JSON.stringify({ mode: receipt.mode, model }));
    const first = await completion(true);
    const selection = selectToolCall(first.tool_calls); // Reject an entire multi-call response before doing anything.
    receipt.decision = selection ? { tool: selection.call.function.name, arguments: selection.args } : { tool: null };
    let final = first;
    if (selection) {
      console.log("toolSelection:", JSON.stringify(receipt.decision));
      messages.push({ role: "assistant", content: first.content ?? null, tool_calls: [selection.call] });
      let result: unknown;
      if (!live) {
        // No endpoint, Blocky402 request, signer, or Tripo invocation exists in this branch.
        result = { dryRun: true, executed: false, paid: false, generated: false,
          prompt: selection.args.prompt, message: "Tool selection validated only. No payment or generation occurred." };
      } else {
        env("TRIPO_API_KEY");
        const payer = env("HEDERA_PAYER_ACCOUNT_ID");
        const recipient = env("HEDERA_PAY_TO_ACCOUNT_ID");
        const privateKey = env("HEDERA_PAYER_PRIVATE_KEY");
        const requirements = await discoverRequirements(recipient);
        service = await startPaymentServer(requirements);
        const invoke = createMesh402Tool({ endpoint: service.url, payer, recipient, privateKey, expectedRequirements: requirements });
        receipt.toolInvocations = 1;
        result = await invoke(selection.args);
      }
      receipt.toolResult = result;
      messages.push({ role: "tool", tool_call_id: selection.call.id, content: redact(JSON.stringify(result)) });
      final = await completion(false); // No tools offered; no execution loop or retry exists.
      if (final.tool_calls?.length) throw new Error("Nebius requested another tool after the limit; not executed");
    }
    if (typeof final.content !== "string" || !final.content.trim()) throw new Error("Nebius returned no final answer");
    receipt.finalAnswer = final.content;
    receipt.status = live && selection ? "success" : selection ? "dry-run-complete" : "answered-without-tool";
    console.log(redact(final.content));
  } catch (error) {
    receipt.status = "failed";
    receipt.error = redact(error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    if (service) receipt.serviceEvidence = service.evidence;
    try {
      await mkdir(resolve("generated"), { recursive: true });
      const path = resolve("generated", "mesh402-agent-receipt.json");
      await writeFile(path, redact(JSON.stringify(receipt, null, 2)));
      console.log("agentReceipt:", path);
    } finally { if (service) await service.close(); }
  }
}

main().catch(error => {
  console.error(redact(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
