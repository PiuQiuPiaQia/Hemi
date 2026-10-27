import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {createBotHost} from '../../src/main/bot/host.mjs';
import {replyToGoalCheck} from './goal-model-fixture.mjs';

export async function untilBot(read, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {const result = await read();if (result) return result;await new Promise(resolve => setTimeout(resolve, 25));}
  throw new Error('Bot fixture timed out');
}
export async function createBotCapabilityFixture(respond, {capabilityOptions = {}, pageHtml = '', root = null} = {}) {
  root ??= await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-capability-'));
  const requests = [], errors = [];
  const server = http.createServer(async (request, response) => {
    if (request.method === 'GET') {response.setHeader('Content-Type', 'text/html; charset=utf-8');response.end(pageHtml);return;}
    try {
      let raw = '';for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);if (replyToGoalCheck(body, response)) return;
      // Upstream pi-memory writes a recap when a real SDK session closes.
      // Answer that independent request without treating it as a scenario turn.
      const recap = body.messages?.some(message => message.role === 'system' && String(message.content).startsWith('You are a session recap assistant.'));
      if (!recap) requests.push(body);
      const answer = recap ? {content: '### Decisions\n- None.\n### Lessons Learned\n- None.\n### Notes\n- Isolated synthetic verification.\n### Follow-ups\n- None.'}
        : await respond(body, {requests, origin: `http://127.0.0.1:${server.address().port}`});
      const delta = answer.tool ? {role: 'assistant', tool_calls: [{index: 0, id: 'call-' + randomUUID(), type: 'function',
        function: {name: answer.tool.name, arguments: JSON.stringify(answer.tool.args ?? {})}}]} : {role: 'assistant', content: answer.content ?? 'OK'};
      response.writeHead(200, {'content-type': 'text/event-stream'});
      response.end('data: ' + JSON.stringify({choices: [{index: 0, delta, finish_reason: null}]}) + '\n\ndata: ' +
        JSON.stringify({choices: [{index: 0, delta: {}, finish_reason: answer.tool ? 'tool_calls' : 'stop'}], usage: {prompt_tokens: 10, completion_tokens: 5, total_tokens: 15}}) + '\n\ndata: [DONE]\n\n');
    } catch (error) {errors.push(error.message);response.writeHead(500);response.end(error.message);}
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const options = {dataDir: path.join(root, 'data'), defaultDir: path.join(root, 'workspace'), capabilityOptions, allowLoopbackModels: true, validateModel: async () => {}};
  let host = await createBotHost(options);const hello = await host.request('handshake');
  const call = (method, params = {}) => host.request(method, {instanceId: hello.instanceId, requestId: 'request-' + randomUUID(), ...params});
  await call('model.sync', {models: [{modelKey: 'fixture/model', providerId: 'fixture', name: 'Fixture', model: 'fixture', api: 'openai-completions',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'synthetic-only-key', supportsVision: true, thinkingLevel: 'off'}]});
  return {root, call, requests, get host() {return host;},
    async send(id, text, input = {}, decidePermission = null) {
      await call('flow.command', {id, command: {type: 'send', input: {inputId: 'input-' + randomUUID(), text, ...input}}});
      return untilBot(async () => {
        if (errors.length) throw new Error('Synthetic provider failed: ' + errors.at(-1));const detail = await call('session.open', {id});
        if (decidePermission) for (const permission of Object.values(detail.permissions ?? {}).filter(permission => permission.status === 'pending')) {
          await call('permission.decide', {id, permissionId: permission.id, value: await decidePermission(permission)});
        }
        return detail.flow.phase === 'idle' && !detail.flow.pending.length ? detail : null;
      }, decidePermission ? 120000 : 30000);
    },
    async restart() {await host.close();host = await createBotHost(options);},
    async close() {await host.close();server.closeAllConnections();await new Promise(resolve => server.close(resolve));await fs.rm(root, {recursive: true, force: true});},
  };
}
