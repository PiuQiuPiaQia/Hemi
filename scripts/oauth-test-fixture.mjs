// Synthetic provider HTTP boundary. Never reads an account, browser profile, or real token.
import http from 'node:http';
import { createBigModelTestProvider } from './bigmodel-test-fixture.mjs';
const json = value => Response.json(value);
const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

export function oauthTestReply(rawUrl, init = {}, bigmodel) {
  const url = new URL(rawUrl);
  const codingReply = bigmodel?.reply(rawUrl, init);
  if (codingReply) return codingReply;
  if (url.pathname.endsWith('/oauth/token')) return json({ access_token: url.hostname.includes('claude') ? 'sk-ant-oat-test-access' : 'openai-test-access', refresh_token: 'test-refresh-rotated', expires_in: 7200, scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct', id_token: 'test-presence-only' });
  if (url.pathname === '/login/device/code') return json({ device_code: 'test-device', user_code: 'HEMI-TEST', verification_uri: 'https://github.com/login/device', interval: 0.01, expires_in: 60 });
  if (url.pathname === '/login/oauth/access_token') return json({ access_token: 'test-github-token', token_type: 'bearer' });
  if (url.pathname === '/copilot_internal/v2/token') return json({ token: 'test-copilot;proxy-ep=proxy.individual.githubcopilot.com;', expires_at: Math.floor(Date.now() / 1000) + 7200 });
  if (url.pathname === '/v1/models') return json({ models: [{ slug: 'gpt-4.1', display_name: 'GPT 4.1', visibility: 'list' }, { slug: 'gpt-4', visibility: 'hidden' }] });
  if (url.pathname === '/models') return json({ data: ['gpt-5-mini', 'claude-sonnet-5.5'].map(id => ({ id, model_picker_enabled: true, policy: { state: 'enabled' }, capabilities: { supports: { tool_calls: true } } })) });
  const body = JSON.parse(init.body || '{}');
  let frames;
  const toolCheck = JSON.stringify(body).includes('Call hemi_connection_check');
  if (url.pathname.endsWith('/responses')) {
    const item = toolCheck ? { id: 'fc-test', type: 'function_call', call_id: 'call-test', name: 'hemi_connection_check', arguments: '{\"ok\":true}', status: 'completed' } : { id: 'msg-test', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OAuth OK', annotations: [] }] };
    frames = [
      event('response.created', { response: { id: 'resp-test', status: 'in_progress', model: body.model, output: [] } }),
      event('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } }),
      event('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }),
      event('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: 'OAuth OK' }),
      event('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text: 'OAuth OK' }),
      event('response.output_item.done', { output_index: 0, item }),
      event('response.completed', { response: { id: 'resp-test', status: 'completed', model: body.model, output: [item], usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } } }),
    ];
  } else if (url.pathname.endsWith('/messages')) frames = [
    event('message_start', { message: { id: 'msg-test', type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: 4, output_tokens: 0 } } }),
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'OAuth OK' } }),
    event('content_block_stop', { index: 0 }),
    event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }), event('message_stop', {}),
  ];
  else if (url.pathname.endsWith('/chat/completions')) frames = [`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'OAuth OK' }, finish_reason: null }] })}\n\n`, `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } })}\n\n`, 'data: [DONE]\n\n'];
  else throw new Error(`Unexpected synthetic provider route: ${url.origin}${url.pathname}`);
  if (toolCheck && url.pathname.endsWith('/responses')) frames = [event('response.created', { response: { id: 'resp-test', status: 'in_progress', model: body.model, output: [] } }), event('response.output_item.added', { output_index: 0, item: { id: 'fc-test', type: 'function_call', call_id: 'call-test', name: 'hemi_connection_check', arguments: '' } }), event('response.function_call_arguments.delta', { item_id: 'fc-test', output_index: 0, delta: '{\"ok\":true}' }), event('response.output_item.done', { output_index: 0, item: { id: 'fc-test', type: 'function_call', call_id: 'call-test', name: 'hemi_connection_check', arguments: '{\"ok\":true}', status: 'completed' } }), event('response.completed', { response: { id: 'resp-test', status: 'completed', model: body.model, output: [], usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } } })];
  if (toolCheck && url.pathname.endsWith('/messages')) frames = [event('message_start', { message: { id: 'msg-test', role: 'assistant', content: [], usage: { input_tokens: 4, output_tokens: 0 } } }), event('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'tool-test', name: body.tools[0].name, input: {} } }), event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{\"ok\":true}' } }), event('content_block_stop', { index: 0 }), event('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } }), event('message_stop', {})];
  return new Response(frames.join(''), { headers: { 'content-type': 'text/event-stream' } });
}

export async function startOAuthTestServer() {
  const requests = [];
  const bigmodel = createBigModelTestProvider();
  const originalFetch = globalThis.fetch;
  const server = http.createServer(async (request, response) => {
    try {
      let body = ''; for await (const chunk of request) body += chunk;
      const target = new URL(request.url, 'http://localhost').searchParams.get('target');
      requests.push({ url: target, body, headers: request.headers });
      const reply = oauthTestReply(target, { body, headers: request.headers, method: request.method }, bigmodel);
      response.writeHead(reply.status, Object.fromEntries(reply.headers));
      response.end(Buffer.from(await reply.arrayBuffer()));
    } catch (error) { response.writeHead(500); response.end(error.message); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const fetch = (url, init) => new URL(String(url)).hostname === '127.0.0.1' ? originalFetch(url, init) : originalFetch(`${origin}/?target=${encodeURIComponent(String(url))}`, init);
  return { requests, fetch, bigmodel, close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }, originalFetch };
}

export async function waitForOAuth(read, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('OAuth verification timed out');
}
