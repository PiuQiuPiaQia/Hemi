// Isolated-process acceptance fixture: real production Bot/core/Pi, local model only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createBotHost } from '../../src/main/bot/host.mjs';
import { validateCloudModel } from '../../src/main/bot/runtime.mjs';

const [dataDir, workspace, endpoint, mode, existingId] = process.argv.slice(2);
let host;
try {
  host = await createBotHost({ dataDir, defaultDir: workspace, allowLoopbackModels: true, validateModel: validateCloudModel });
  const hello = await host.request('handshake');
  const call = (method, args = {}) => host.request(method, { instanceId: hello.instanceId, requestId: `op-${randomUUID()}`, ...args });
  if (mode === 'first') {
    const result = await call('model.sync', { models: [{ modelKey: 'test/native', providerId: 'test', name: 'Native fixture',
      model: 'native-fixture', baseUrl: endpoint, api: 'openai-completions', apiKey: 'fixture-only', thinkingLevel: 'off' }] });
    assert.equal(result.results[0].ok, true);
  }
  const id = existingId || (await call('session.create')).id;
  const text = mode === 'first' ? 'REMEMBER_NATIVE_FIRST secret=amber-731'
    : mode === 'legacy' ? 'CONTINUE_AFTER_LEGACY_MIGRATION' : 'CONTINUE_AFTER_NATIVE_RESTART';
  const receipt = await call('flow.command', { id, command: { type: 'send', input: { inputId: `input-${mode}`, text } } });
  assert.equal(receipt.ok, true);
  let detail;
  for (let i = 0; i < 800; i++) {
    detail = await call('session.open', { id });
    if (detail.flow.phase === 'idle' && Object.values(detail.flow.runs).at(-1)?.outcome === 'completed') break;
    if (Object.values(detail.flow.runs).at(-1)?.outcome === 'failed') throw new Error(JSON.stringify(detail.flow.timeline));
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(Object.values(detail.flow.runs).at(-1)?.outcome, 'completed');
  await host.close(); host = null;
  console.log('NATIVE_RESULT ' + JSON.stringify({ id, timeline: detail.flow.timeline }));
} catch (error) {
  console.error(error.stack); process.exitCode = 1;
} finally { if (host) await host.close(); }
// close() has awaited all host/core writes. Do not wait for SDK initialization
// timeout promises that have already lost their Promise.race.
process.exit(process.exitCode ?? 0);
