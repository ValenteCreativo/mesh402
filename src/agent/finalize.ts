export const AGENT_SYSTEM_PROMPT = "You consume Mesh402, agent-native 3D infrastructure. Decide whether the user's request needs an actual newly generated 3D asset. If yes, you may call generate_3d_asset once, costing 0.001 HBAR on Hedera testnet. If not, answer without tools or spending. Never call more than one tool. Use the tool result as evidence; never invent successful payment, generation, URLs, or local paths. If a result says dryRun, clearly state that nothing was purchased or generated.";

/** Finalization only: no tool imports, tool declarations, dispatcher, or retries. */
export async function finalizeResponse(messages: Record<string, unknown>[]) {
  const model = process.env.NEBIUS_MODEL?.trim();
  const key = process.env.NEBIUS_API_KEY?.trim();
  const base = process.env.NEBIUS_BASE_URL?.trim().replace(/\/$/, "");
  if (!model || !key || !base) throw new Error("Nebius model, base URL and API key must be configured");
  if (new URL(base).protocol !== "https:") throw new Error("Nebius base URL must use HTTPS");
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(90_000),
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 1024, messages: [...messages,
      { role: "system", content: "Finalization only. No tools are available. Summarize the supplied tool result in at most two short sentences (80 words). Do not reproduce URLs, signatures, JSON, or long file paths. Do not request another execution. Describe only what the evidence proves. Clearly label dry-run results as not executed." },
    ] }),
  });
  const text = (await response.text()).split(key).join("[REDACTED]");
  if (!response.ok) throw new Error(`Nebius finalization HTTP ${response.status}: ${text}`);
  const parsed = JSON.parse(text);
  const choice = parsed.choices?.[0];
  return { model, responseId: parsed.id ?? null, finishReason: choice?.finish_reason ?? null,
    truncated: choice?.finish_reason === "length", usage: parsed.usage ?? null,
    maxTokens: 1024, toolsEnabled: false, message: choice?.message ?? null };
}

export function assertFinalResponse(result: Awaited<ReturnType<typeof finalizeResponse>>) {
  if (result.truncated) throw new Error(`Nebius final response truncated (finish_reason=${result.finishReason}); paid tool must not be rerun`);
  if (result.finishReason !== "stop" || result.message?.role !== "assistant" ||
      result.message.tool_calls?.length || typeof result.message.content !== "string" || !result.message.content.trim()) {
    throw new Error(`Nebius final response incomplete or invalid (finish_reason=${result.finishReason}); no tool execution permitted`);
  }
}
