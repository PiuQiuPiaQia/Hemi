import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createHemiSession } from './hemi-session.mjs';
import { createRunJournal } from '../agent-runtime/run-journal.mjs';
import { createContextStore } from '../agent-runtime/context-store.mjs';

for (const routed of [true, false]) test(`real SDK recovers a first-output timeout ${routed ? 'through the fallback' : 'on the same candidate'} without repeating a completed tool`, { timeout: 15000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hemi-model-timeout-'));
  await writeFile(path.join(dir, 'fixture.txt'), 'READ_ONCE');
  // Accelerate only the intentionally silent response; retain cold-start deadlines.
  const realTimeout = globalThis.setTimeout;
  const requests = [];
  let waitingForOutput = false;
  t.mock.method(globalThis, 'setTimeout', (fn, delay, ...args) => realTimeout(fn, delay === 300000 && waitingForOutput ? 500 : delay, ...args));
  let afterTool = 0;
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'timeout', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (!body.messages.some(message => message.role === 'tool')) {
      send({ role: 'assistant', tool_calls: [{ index: 0, id: 'read-once', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: path.join(dir, 'fixture.txt') }) } }] });
      send({}, 'tool_calls');
    } else if (afterTool++ === 0) {
      waitingForOutput = true;
      res.flushHeaders();
      return; // Connected, but no model output arrives before the host deadline.
    } else {
      waitingForOutput = false;
      send({ role: 'assistant', content: 'RECOVERED' });
      send({}, 'stop');
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const primary = { modelKey: 'p/main', providerId: 'p', credentialRef: 'p', model: 'primary', api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'SYNTHETIC_ONLY' };
  const fallback = { ...primary, modelKey: 'p/fallback', model: 'fallback' };
  const journal = createRunJournal({ dir: path.join(dir, 'journal') });
  const owner = { conversationId: 'c', rootRunId: 'r', generation: 1 };
  await journal.beginRoot(owner);
  const execution = { journal, owner, contextStore: createContextStore({ dir: path.join(dir, 'contexts') }), allowedRefs: [], purpose: 'main', plan: { role: 'main', primary, allowedFallbacks: routed ? [fallback] : [] }, store: { resolveStrict: async key => ({ ok: true, config: key === fallback.modelKey ? fallback : primary }) }, budgets: { maxRequestsPerRun: 10 }, cancelled: () => false };
  const session = createHemiSession({ cwd: dir, agentDir: dir, ...(routed ? { routing: { execution: primary, fallback, fallbacks: [fallback] } } : { model: primary }), tools: ['read'], features: {}, accessWorkspaceDir: dir, executionContext: execution, initTimeoutMs: 2000, stallTimeoutMs: 10000 });
  t.after(async () => {
    session.dispose();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const recoveries = [];
  session.on('recovery', state => recoveries.push(state));
  const result = await session.prompt('Read fixture.txt and reply.');
  assert.equal(result.modelError, null);
  assert.equal(result.lastText, 'RECOVERED');
  assert.deepEqual(requests.map(body => body.model), ['primary', 'primary', routed ? 'fallback' : 'primary']);
  for (const body of requests.slice(1)) assert.equal(body.messages.filter(message => message.role === 'tool').length, 1);
  const entries = (await session.exportEntries()).entries;
  assert.equal(entries.filter(entry => entry.message?.role === 'toolResult').length, 1);
  const recorded = Object.values((await journal.snapshot()).requests);
  assert.equal(recorded.length, 3);
  assert.equal(recorded[1].failure.code, 'TIMEOUT');
  assert.equal(recorded[1].failure.phase, 'first-output');
  assert.equal(recorded[1].failure.httpStatus, 200);
  assert.equal(recorded[2].logicalCallId, recorded[1].logicalCallId);
  assert.equal(recorded[2].recovery.id, recorded[1].recovery.id);
  assert.equal(recorded[2].error, null);
  if (!routed) assert.equal(recoveries.at(-1).phase, 'recovered');
  if (routed) {
    await session.prompt('Continue the same root.');
    assert.equal(requests.at(-1).model, 'fallback');
    await journal.finishRoot(owner, 'completed');
    const next = { ...owner, rootRunId: 'next-root' }; await journal.beginRoot(next);
    session.setExecutionContext({ ...execution, owner: next });
    await session.prompt('A new user root.');
    assert.equal(requests.at(-1).model, 'primary');
    assert.equal((await session.exportEntries()).entries.filter(entry => entry.message?.role === 'toolResult').length, 1);
  }
});
