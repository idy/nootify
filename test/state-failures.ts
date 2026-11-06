import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { State } from '../src/state.js';

/** Queue two successful saves ahead of a settings change, then fail only that change's atomic replacement. */
export async function failSettingsWriteBehindOlderSaves(t: TestContext, state: State, change: () => Promise<unknown>): Promise<void> {
  let entered!: () => void; let release!: () => void; let queued!: () => void;
  const blocked = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const settingsQueued = new Promise<void>(resolve => { queued = resolve; });
  t.after(() => release());
  const rename = fs.rename; let writes = 0;
  t.mock.method(fs, 'rename', async (from: Parameters<typeof rename>[0], to: Parameters<typeof rename>[1]) => {
    if (String(to) === join(state.directory, 'state.json')) {
      const index = ++writes;
      if (index === 1) { entered(); await gate; }
      if (index === 3) throw new Error('Injected settings write failure');
    }
    return rename(from, to);
  });
  const save = state.save.bind(state); let scheduled = 0;
  t.mock.method(state, 'save', (transaction?: Parameters<State['save']>[0]) => {
    const operation = save(transaction);
    if (++scheduled === 3) queued();
    return operation;
  });
  const first = state.save(); await blocked;
  const older = state.save();
  const failed = assert.rejects(change(), /Injected settings write failure/);
  await settingsQueued; release();
  await Promise.all([first, older, failed]);
}
