import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readJson, writeJson } from '../storage.js';

export type PublicState = {
  version: 1; created: number; completed: number;
  attempts: Record<string, { status: string; taskId?: string }>;
  assets: Record<string, Record<string, unknown>>;
  active: { transactionId: string; phase: string; taskId?: string } | null;
};
const fresh = (): PublicState => ({ version: 1, created: 0, completed: 0, attempts: {}, assets: {}, active: null });
export async function publicQuota(directory: string, max: number) {
  await mkdir(directory, { recursive: true });
  const file = resolve(directory, 'state.json'), lock = resolve(directory, 'execution.lock');
  let state: PublicState = await readJson(file, fresh());
  const exists = () => readFile(lock).then(() => true).catch(e => { if (e.code === 'ENOENT') return false; throw e; });
  // Never infer that a remote settlement/task was cancelled when a process ended.
  let recovery = !!state.active || await exists();
  let held = false;
  let writes = Promise.resolve();
  function update(change: () => void) {
    change(); const snapshot = structuredClone(state);
    writes = writes.then(() => writeJson(file, snapshot)); return writes;
  }
  function availability() {
    if (recovery) return 'reconciliation_required';
    if (held || state.active) return 'generation_in_progress';
    if (state.created >= max) return 'quota_exhausted';
    return null;
  }
  return {
    availability, snapshot: () => structuredClone(state),
    async claim(transactionId: string) {
      const unavailable = availability(); if (unavailable) return unavailable;
      if (state.attempts[transactionId]) return 'payment_already_attempted';
      held = true; // Synchronous guard before any await.
      try {
        const handle = await open(lock, 'wx', 0o600); await handle.close();
      } catch (e) {
        held = false;
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') { recovery = true; return 'reconciliation_required'; }
        throw e;
      }
      // Refresh under the disk lock as well as the process guard.
      state = await readJson(file, fresh());
      if (state.active) { recovery = true; return 'reconciliation_required'; }
      if (state.created >= max || state.attempts[transactionId]) {
        const reason = state.created >= max ? 'quota_exhausted' : 'payment_already_attempted';
        await unlink(lock); held = false; return reason;
      }
      await update(() => {
        state.active = { transactionId, phase: 'verifying' };
        state.attempts[transactionId] = { status: 'verifying' };
      });
      return null;
    },
    phase(phase: string) { return update(() => { state.active!.phase = phase; state.attempts[state.active!.transactionId].status = phase; }); },
    created(taskId: string) {
      return update(() => {
        if (!state.active!.taskId) { state.created++; state.active!.taskId = taskId; }
        if (state.active!.taskId !== taskId) throw new Error('Unexpected second task');
        state.active!.phase = 'generating';
        state.attempts[state.active!.transactionId] = { status: 'generating', taskId };
      });
    },
    async rejected() {
      await update(() => { state.attempts[state.active!.transactionId].status = 'verification_rejected'; state.active = null; });
      await unlink(lock); held = false;
    },
    async complete(taskId: string, result: Record<string, unknown>) {
      await update(() => {
        if (state.active?.taskId !== taskId) throw new Error('Task creation evidence missing');
        state.assets[taskId] = result; state.completed++;
        state.attempts[state.active.transactionId].status = 'completed'; state.active = null;
      });
      await unlink(lock); held = false;
    },
    async ambiguous() {
      recovery = true;
      await update(() => { if (state.active) { state.active.phase = 'ambiguous'; state.attempts[state.active.transactionId].status = 'ambiguous'; } });
      // Retain lock and reservation until explicit human reconciliation.
    },
  };
}
