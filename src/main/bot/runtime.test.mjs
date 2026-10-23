import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBotExecutor } from './runtime.mjs';

test('stop during permission-store startup cancels before constructing an SDK session', async (t) => {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'hemi-bot-stop-startup-'),
  );
  const executor = createBotExecutor({
    dataDir,
    getModel: () => {
      throw new Error('cancelled run must not resolve model credentials');
    },
  });
  t.after(async () => {
    await executor.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const pending = executor.run(
    {
      conversationId: 'cancel-before-ready',
      runId: 'run-cancel',
      generation: 1,
      envelope: {},
    },
    () => {},
  );
  await executor.stop('cancel-before-ready');
  assert.deepEqual(await pending, { stopped: true });
});
