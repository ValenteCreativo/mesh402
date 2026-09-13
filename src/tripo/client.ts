import { setTimeout as sleep } from "node:timers/promises";

const BASE_URL = "https://openapi.tripo3d.ai/v3";
const TERMINAL_ERRORS = new Set(["failed", "cancelled", "canceled", "expired", "banned", "unknown"]);

export interface GeneratedAsset {
  taskId: string;
  glbUrl: string;
  previewUrl?: string;
  consumedCredit?: number;
}

export interface GenerateOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  onProgress?: (progress: number, status: string) => void;
  signal?: AbortSignal;
  /** Optional spike diagnostics: parsed API responses, never request headers. */
  onResponse?: (path: string, response: Record<string, unknown>) => void;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function generateAsset(prompt: string, options: GenerateOptions = {}): Promise<GeneratedAsset> {
  const key = process.env.TRIPO_API_KEY?.trim();
  if (!key) throw new Error("TRIPO_API_KEY is required");
  if (!prompt.trim()) throw new Error("Prompt must not be empty");
  const timeoutMs = options.timeoutMs ?? 240_000;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  for (const [name, value] of Object.entries({ timeoutMs, pollIntervalMs })) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
      throw new Error(`${name} must be a positive timer-safe integer`);
    }
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  let taskId: string | undefined;

  async function request(path: string, body?: unknown): Promise<Record<string, unknown>> {
    const response = await fetch(`${BASE_URL}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
      redirect: "error",
    });
    // Redact the key even if an upstream error unexpectedly echoes it.
    const text = (await response.text()).split(key!).join("[REDACTED]");
    let envelope: unknown;
    try { envelope = JSON.parse(text); } catch {
      throw new Error(`Tripo ${path} HTTP ${response.status}: ${text}`);
    }
    if (!response.ok || !record(envelope) || envelope.code !== 0) {
      throw new Error(`Tripo ${path} HTTP ${response.status}: ${text}`);
    }
    options.onResponse?.(path, envelope);
    if (!record(envelope.data)) throw new Error(`Tripo ${path}: missing data object: ${text}`);
    return envelope.data;
  }

  try {
    signal.throwIfAborted();
    const created = await request("/generation/text-to-model", {
      prompt: prompt.trim(), model: "v3.1-20260211",
    });
    if (typeof created.task_id !== "string" || !created.task_id) throw new Error("Tripo creation response missing task_id");
    taskId = created.task_id;
    for (;;) {
      const task = await request(`/tasks/${encodeURIComponent(taskId)}`);
      if (typeof task.status !== "string") throw new Error(`Tripo task ${taskId}: missing status`);
      options.onProgress?.(typeof task.progress === "number" ? task.progress : 0, task.status);
      if (task.status === "success") {
        if (!record(task.output) || typeof task.output.model_url !== "string" || !task.output.model_url) {
          throw new Error(`Tripo task ${taskId} succeeded without output.model_url: ${JSON.stringify(task)}`);
        }
        return {
          taskId,
          glbUrl: task.output.model_url,
          ...(typeof task.output.rendered_image_url === "string" ? { previewUrl: task.output.rendered_image_url } : {}),
          ...(typeof task.credits_consumed === "number" ? { consumedCredit: task.credits_consumed } : {}),
        };
      }
      if (TERMINAL_ERRORS.has(task.status)) throw new Error(`Tripo task ${taskId}: ${JSON.stringify(task)}`);
      await sleep(pollIntervalMs, undefined, { signal });
    }
  } catch (error) {
    if (timeout.aborted) throw new Error(`Tripo timed out after ${timeoutMs}ms; taskId=${taskId ?? "not received"}. Remote generation may still run.`);
    if (options.signal?.aborted) throw new Error(`Tripo polling aborted; taskId=${taskId ?? "not received"}. Remote generation is not cancelled.`);
    throw error;
  }
}
