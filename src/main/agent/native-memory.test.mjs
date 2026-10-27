import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import http from 'node:http';
import { createHemiSession } from './hemi-session.mjs';

test('official SDK loader shares one native memory library and concurrent same-process writes retain every update', { timeout: 30000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-native-memory-'));
  const values = { PI_MEMORY_DIR: root, PI_MEMORY_QMD_UPDATE: 'off', PI_MEMORY_EXIT_SUMMARY: '0', PI_MEMORY_SNAPSHOT: 'per-turn', PI_MEMORY_NO_SEARCH: '1' };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const entry = fileURLToPath(import.meta.resolve('pi-memory'));
  async function load(id) {
    const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: SettingsManager.inMemory(), additionalExtensionPaths: [entry], noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await loader.reload();
    const result = loader.getExtensions();
    assert.deepEqual(result.errors, []);
    const extension = result.extensions[0];
    const ctx = { hasUI: false, sessionManager: { getSessionId: () => id } };
    for (const handler of extension.handlers.get('session_start') ?? []) await handler({ type: 'session_start' }, ctx);
    return {
      execute: (name, args) => extension.tools.get(name).definition.execute('native-test', args, undefined, undefined, ctx),
      async prompt() {
        let systemPrompt = 'HEMI_BASE';
        for (const handler of extension.handlers.get('before_agent_start') ?? []) {
          const output = await handler({ type: 'before_agent_start', systemPrompt, prompt: 'native memory test' }, ctx);
          systemPrompt = output?.systemPrompt ?? systemPrompt;
        }
        return systemPrompt;
      },
    };
  }
  const first = await load('first');
  await first.execute('memory_write', { target: 'long_term', content: 'FIRST_PRIVATE_SNAPSHOT' });
  assert.match(await first.prompt(), /FIRST_PRIVATE_SNAPSHOT/);
  const second = await load('second');
  await second.execute('memory_write', { target: 'long_term', content: 'SECOND_PRIVATE_SNAPSHOT' });
  assert.match(await second.prompt(), /SECOND_PRIVATE_SNAPSHOT/);
  assert.match(await first.prompt(), /SECOND_PRIVATE_SNAPSHOT/, 'native per-turn mode reads updates from the shared library');
  const resumed = await load('resumed');
  assert.match(await resumed.prompt(), /FIRST_PRIVATE_SNAPSHOT/);
  assert.match(await resumed.prompt(), /SECOND_PRIVATE_SNAPSHOT/);
  await Promise.all(Array.from({ length: 40 }, (_, index) => (index % 2 ? first : second).execute('memory_write', {
    target: 'long_term', content: `CONCURRENT_NATIVE_WRITE_${String(index).padStart(3, '0')}`,
  })));
  const memory = await fs.readFile(path.join(root, 'MEMORY.md'), 'utf8');
  for (let index = 0; index < 40; index++) assert.equal(memory.split(`CONCURRENT_NATIVE_WRITE_${String(index).padStart(3, '0')}`).length, 2);
});

test('production Hemi sessions execute original memory tools and share native request context across projects', { timeout: 30000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-native-sdk-'));
  const values = { PI_MEMORY_DIR: path.join(root, 'pi-memory'), PI_MEMORY_QMD_UPDATE: 'off', PI_MEMORY_EXIT_SUMMARY: '0', PI_MEMORY_SNAPSHOT: 'per-turn', PI_MEMORY_NO_SEARCH: '1' };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  const requests = [], sessions = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    assert.ok(!(body.tools ?? []).some(tool => ['memory_search', 'memory_status'].includes(tool.function?.name)), 'Hemi must not declare unavailable qmd tools');
    const lastUser = body.messages.findLastIndex(message => message.role === 'user');
    const operation = String(JSON.stringify(body.messages[lastUser]));
    const toolName = operation.includes('SAVE_SHARED_FACT') ? 'memory_write' : operation.includes('READ_SHARED_FACT') ? 'memory_read' : null;
    const tool = toolName && !body.messages.slice(lastUser).some(message => message.role === 'tool') ? {
      index: 0, id: `native-${requests.length}`, type: 'function', function: {
        name: toolName, arguments: JSON.stringify(toolName === 'memory_write' ? { target: 'long_term', content: 'NATIVE_SHARED_PROJECT_FACT' } : { target: 'long_term' }),
      },
    } : null;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: tool ? { role: 'assistant', tool_calls: [tool] } : { role: 'assistant', content: 'OK' }, finish_reason: null }] })}\n\n`);
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await Promise.all(sessions.map(session => session.close('reload')));
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  async function make(project) {
    const cwd = path.join(root, project); await fs.mkdir(cwd);
    const session = createHemiSession({ cwd, agentDir: path.join(root, 'agent'), nativeMemory: true, tools: ['memory_write', 'memory_read', 'memory_forget', 'memory_restore', 'scratchpad', 'memory_status', 'memory_search'], model: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'synthetic', model: 'native-test' }, features: {} });
    sessions.push(session); return session;
  }
  const first = await make('project-a');
  assert.equal((await first.prompt('SAVE_SHARED_FACT')).modelError, null);
  assert.match(await fs.readFile(path.join(values.PI_MEMORY_DIR, 'MEMORY.md'), 'utf8'), /NATIVE_SHARED_PROJECT_FACT/);
  const second = await make('project-b');
  assert.equal((await second.prompt('READ_SHARED_FACT')).modelError, null);
  assert.match(JSON.stringify(requests.at(-1).messages), /NATIVE_SHARED_PROJECT_FACT/);
  const declared = requests[0].tools.find(tool => tool.function?.name === 'memory_write').function;
  assert.deepEqual(declared.parameters.properties.target.enum, ['long_term', 'daily']);
  assert.equal(requests[0].tools.filter(tool => tool.function?.name === 'memory_write').length, 1);
  const entries = await second.exportEntries();
  assert.match(JSON.stringify(entries), /NATIVE_SHARED_PROJECT_FACT/);
});

test('native normal shutdown writes one original summary and reload does not summarize', { timeout: 30000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-native-summary-'));
  const values = { PI_MEMORY_DIR: path.join(root, 'pi-memory'), PI_MEMORY_QMD_UPDATE: 'off', PI_MEMORY_EXIT_SUMMARY: '1', PI_MEMORY_SNAPSHOT: 'per-turn', PI_MEMORY_NO_SEARCH: '1' };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  let summaries = 0;
  const notices = [], sessions = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const summarizing = JSON.stringify(body.messages).includes('Review the conversation and extract');
    if (summarizing) summaries++;
    const content = summarizing ? '### Decisions\n- NATIVE_EXIT_SUMMARY_PROOF\n### Lessons Learned\nNone.\n### Notes\nNone.\n### Follow-ups\nNone.' : 'OK';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({choices:[{index:0,delta:{role:'assistant',content},finish_reason:null}]})}\n\ndata: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}})}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await Promise.all(sessions.map(session => session.close('reload')));
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const make = (routed = false) => {
    const model={api:'openai-completions',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKey:'synthetic',model:'native-summary'};
    const session = createHemiSession({cwd:root,agentDir:path.join(root,'agent'),nativeMemory:true,tools:[],features:{},...(routed ? {routing:{execution:model,fallback:null}} : {model}),log:{info:message=>notices.push(message),warn:message=>notices.push(message)}});
    sessions.push(session);return session;
  };
  const reloading=make();await reloading.prompt('First decision');await reloading.prompt('Second decision');
  await reloading.close('reload');assert.equal(summaries,0);
  const ending=make(true);await ending.prompt('First decision');await ending.prompt('Second decision');
  assert.equal(summaries,0,'a completed application turn is not a shutdown');
  await Promise.all([ending.close(),ending.close()]);
  assert.equal(summaries,1,JSON.stringify(notices));
  const daily=await fs.readdir(path.join(values.PI_MEMORY_DIR,'daily'));
  const text=await fs.readFile(path.join(values.PI_MEMORY_DIR,'daily',daily[0]),'utf8');
  assert.equal(text.split('NATIVE_EXIT_SUMMARY_PROOF').length,2);
});
