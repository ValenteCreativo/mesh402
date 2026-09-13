import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generateAsset } from "../src/tripo/client.js";

const prompt = "low-poly cyberpunk vending machine, game-ready";
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
const responses: { path: string; response: Record<string, unknown> }[] = [];
const started = Date.now();

try {
  console.log(JSON.stringify({ prompt, model: "v3.1-20260211" }));
  const asset = await generateAsset(prompt, {
    timeoutMs: 240_000,
    pollIntervalMs: 2_000,
    signal: controller.signal,
    onProgress: (progress, status) => console.log(JSON.stringify({ status, progress })),
    onResponse: (path, response) => {
      responses.push({ path, response });
      if (path === "/generation/text-to-model") console.log("creation:", JSON.stringify(response));
    },
  });
  console.log("result:", JSON.stringify(asset, null, 2));
  const directory = resolve("generated");
  await mkdir(directory, { recursive: true });
  const filename = encodeURIComponent(asset.taskId);
  await writeFile(resolve(directory, `${filename}.responses.json`), JSON.stringify(responses, null, 2));

  // Signed URL only; never forward the Tripo API key to asset storage.
  const download = await fetch(asset.glbUrl, {
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
  });
  if (!download.ok) throw new Error(`GLB download HTTP ${download.status}: ${await download.text()}`);
  const glb = Buffer.from(await download.arrayBuffer());
  if (glb.length < 12 || glb.toString("ascii", 0, 4) !== "glTF" || glb.readUInt32LE(4) !== 2 || glb.readUInt32LE(8) !== glb.length) {
    throw new Error("Downloaded result is not a valid GLB v2 container (magic/version/length mismatch)");
  }
  const localPath = resolve(directory, `${filename}.glb`);
  await writeFile(localPath, glb);
  console.log(JSON.stringify({ status: "success", localPath, bytes: glb.length, elapsedMs: Date.now() - started }, null, 2));
  console.log("finalTaskResponse:", JSON.stringify(responses.at(-1)?.response, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const key = process.env.TRIPO_API_KEY?.trim();
  console.error(key ? message.split(key).join("[REDACTED]") : message);
  process.exitCode = 1;
}
