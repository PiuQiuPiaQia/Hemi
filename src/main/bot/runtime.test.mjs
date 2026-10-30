import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBotExecutor, validateCloudModel } from './runtime.mjs';
import { createOAuthModels, withOAuthRuntime } from '../services/oauth-models.mjs';
import { transientOAuthCredentials } from './oauth.mjs';
import { codexTestAccess } from '../../../scripts/oauth-test-fixture.mjs';

test('model validation deadline aborts the actual native fetch and preserves the cancellation reason', {timeout: 10000}, async t => {
  const originalFetch = globalThis.fetch;
  const credentials = transientOAuthCredentials('validation-deadline');
  await credentials.modify('openai', async () => ({type: 'oauth', access: codexTestAccess('validation-deadline'), refresh: 'test-refresh-rotated', expires: Date.now() + 600000}));
  const runtime = createOAuthModels(credentials);
  const [model] = await runtime.catalog('openai');
  const controller = new AbortController(), started = Promise.withResolvers();
  let nativeSignal;
  globalThis.fetch = (_url, init) => new Promise((resolve, reject) => {
    nativeSignal = init.signal;
    nativeSignal.addEventListener('abort', () => reject(nativeSignal.reason), {once: true});
    started.resolve();
  });
  t.after(() => { globalThis.fetch = originalFetch; credentials.clear(); });
  const pending = withOAuthRuntime(runtime, () => validateCloudModel({...model, model: model.id, oauthProvider: 'openai', apiKey: 'oauth'}, {signal: controller.signal}));
  const reason = new Error('validation cancelled');
  const rejected = assert.rejects(pending, error => error === reason);
  await started.promise;
  controller.abort(reason);
  await rejected;
  assert.equal(nativeSignal.aborted, true);
});

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
