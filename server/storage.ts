import { mkdir, readFile, writeFile, rename, open } from 'node:fs/promises';
import { resolve } from 'node:path';
export async function readJson(path: string, fallback: any) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw e; }
}
export async function writeJson(path: string, data: unknown) {
  const temp = `${path}.tmp`;
  await writeFile(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await rename(temp, path);
}
export async function storage(directory: string, mode: string) {
  await mkdir(directory, { recursive: true });
  const statePath = resolve(directory, `${mode}-state.json`);
  const lockPath = resolve(directory, `${mode}.lock`);
  const registryPath = resolve(directory, 'registry.json');
  const registry: Record<string, any> = await readJson(registryPath, {});
  let state = await readJson(statePath, null);
  // A lock without a completed receipt is deliberately fail-closed after a crash.
  const locked = await readFile(lockPath, 'utf8').then(() => true).catch(e => { if (e.code === 'ENOENT') return false; throw e; });
  if ((locked && !state) || state?.status === 'running') {
    state = { ...state, status: 'ambiguous', message: 'Execution interrupted. Human reconciliation required; no automatic retry.' };
    await writeJson(statePath, state);
  }
  let queue = Promise.resolve();
  const update = (patch: object) => {
    state = { ...state, ...patch };
    const snapshot = { ...state };
    queue = queue.then(() => writeJson(statePath, snapshot)); return queue;
  };
  return { registry, getState: () => state, update,
    async claim(request: string) {
      if (state) return false;
      try { const f = await open(lockPath, 'wx', 0o600); await f.close(); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false; throw e; }
      await update({ status: 'running', request, startedAt: new Date().toISOString(), mode }); return true;
    },
    async register(evidence: any) { registry[evidence.taskId] = evidence; await writeJson(registryPath, registry); },
  };
}
