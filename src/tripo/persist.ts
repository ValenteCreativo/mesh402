import { mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { GeneratedAsset } from "./client.js";

/** Download immediately; persist only a complete, validated GLB v2 container. */
export async function persistGlb(asset: GeneratedAsset) {
  // Asset storage receives the signed URL, never the Tripo API key.
  const response = await fetch(asset.glbUrl, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`GLB download HTTP ${response.status}: ${await response.text()}`);
  const glb = Buffer.from(await response.arrayBuffer());
  if (glb.length < 12 || glb.toString("ascii", 0, 4) !== "glTF" ||
      glb.readUInt32LE(4) !== 2 || glb.readUInt32LE(8) !== glb.length) {
    throw new Error("Downloaded result is not a valid GLB v2 container (magic/version/length mismatch)");
  }
  const directory = resolve("generated");
  await mkdir(directory, { recursive: true });
  const localGlbPath = resolve(directory, `${encodeURIComponent(asset.taskId)}.glb`);
  await writeFile(`${localGlbPath}.part`, glb);
  await rename(`${localGlbPath}.part`, localGlbPath);
  return { localGlbPath, glbBytes: glb.length };
}
