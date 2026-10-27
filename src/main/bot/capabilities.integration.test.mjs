import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createBotCapabilityFixture} from '../../../scripts/lib/bot-capability-fixture.mjs';
import {createBrowserBridgeService} from '../services/browser-bridge-service.mjs';
import {findHeadlessExecutable} from '../services/headless-browser-service.mjs';

let browserAvailable = true;try {findHeadlessExecutable();} catch {browserAvailable = false;}
test('actual Bot SDK exposes configured search/extract tools and reaches their provider HTTP boundary', async t => {
  const calls = [];
  const provider = http.createServer(async (request, response) => {
    let raw = '';for await (const chunk of request) raw += chunk;calls.push({url: request.url, body: JSON.parse(raw)});
    response.setHeader('Content-Type', 'application/json');response.end(JSON.stringify({results: [{title: 'Search proof', url: 'https://example.com/proof', content: 'SEARCH_BOUNDARY', raw_content: 'EXTRACT_BOUNDARY'}]}));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const fixture = await createBotCapabilityFixture(body => {
    const results = body.messages.filter(message => message.role === 'tool');
    return results.length === 0 ? {tool: {name: 'web_search', args: {query: 'proof'}}}
      : results.length === 1 ? {tool: {name: 'web_extract', args: {url: 'https://example.com/proof'}}} : {content: 'WEB_COMPLETE'};
  }, {capabilityOptions: {platform: 'linux', webFetchImpl: (url, init) => fetch(`http://127.0.0.1:${provider.address().port}${new URL(url).pathname}`, init)}});
  t.after(async () => {await fixture.close();provider.closeAllConnections();await new Promise(resolve => provider.close(resolve));});
  await fixture.call('capabilities.configure', {config: {searchApiKey: 'synthetic-search-key', browserEnabled: false}});
  const session = await fixture.call('session.create');await fixture.send(session.id, 'WEB_PROOF');
  const names = fixture.requests[0].tools.map(tool => tool.function.name);assert.ok(names.includes('web_search'));assert.ok(names.includes('web_extract'));assert.ok(!names.includes('browser_navigate'));
  assert.deepEqual(calls.map(call => call.url), ['/search', '/extract']);
  const results = fixture.requests.at(-1).messages.filter(message => message.role === 'tool').map(message => message.content).join('\n');
  assert.match(results, /SEARCH_BOUNDARY/);assert.match(results, /EXTRACT_BOUNDARY/);
  assert.equal(JSON.stringify(await fixture.call('snapshot')).includes('synthetic-search-key'), false);
});
test('actual Bot Host/SDK navigates, types, clicks, reads and screenshots a real isolated browser, then closes its task', {timeout: 30000, skip: !browserAvailable}, async t => {
  let bridge;
  const fixture = await createBotCapabilityFixture((body, {origin}) => {
    const results = body.messages.filter(message => message.role === 'tool');
    const steps = [
      {name: 'browser_navigate', args: {url: origin + '/page', taskTitle: '验证 Bot 浏览器'}},
      {name: 'browser_type', args: {selector: '#input', text: '中文 Bot 浏览器🙂'}},
      {name: 'browser_click', args: {selector: '#apply'}},
      {name: 'browser_extract', args: {}},
      {name: 'browser_screenshot', args: {}},
    ];
    return results.length < steps.length ? {tool: steps[results.length]} : {content: 'BOT_BROWSER_COMPLETE'};
  }, {capabilityOptions: {platform: 'linux', browserFactory: options => bridge = createBrowserBridgeService({...options, ports: [0], extensionWaitMs: 0})},
    pageHtml: '<!doctype html><meta charset="utf-8"><title>Bot capability fixture</title><input id="input"><button id="apply" onclick="document.querySelector(\'#result\').textContent=document.querySelector(\'#input\').value">Apply</button><p id="result"></p>'});
  t.after(() => fixture.close());
  const session = await fixture.call('session.create');const detail = await fixture.send(session.id, 'BROWSER_PROOF');
  assert.equal(Object.values(detail.flow.runs).at(-1).outcome, 'completed');
  const request = fixture.requests.at(-1), results = request.messages.filter(message => message.role === 'tool');
  assert.equal(results.length, 5);assert.ok(results.some(message => String(message.content).includes('中文 Bot 浏览器🙂')));
  assert.ok(JSON.stringify(fixture.requests).includes('data:image/'), 'the actual browser screenshot reaches a vision-capable model');
  assert.deepEqual(bridge.activeTaskIds, []);
  const names = fixture.requests[0].tools.map(tool => tool.function.name);
  assert.ok(names.includes('browser_navigate'));assert.ok(names.includes('conversation_read'));assert.ok(!names.includes('screen_view'));
});

test('actual Bot conversation_read retrieves early and long public history across pages and Host restart', {timeout: 30000}, async t => {
  const pages = [];
  const fixture = await createBotCapabilityFixture(body => {
    const raw = body.messages.findLast(message => message.role === 'user')?.content;
    const input = Array.isArray(raw) ? raw.filter(block => block.type === 'text').map(block => block.text).join('\n') : String(raw);
    if (String(input).includes('ARCHIVE_')) return {content: String(input).match(/ARCHIVE_\d+/)?.[0] === 'ARCHIVE_0' ? 'EARLY_PROOF_' + '历史正文。'.repeat(6000) : 'ARCHIVED_REPLY'};
    const results = body.messages.filter(message => message.role === 'tool');
    const previous = results.length ? JSON.parse(results.at(-1).content) : null;
    if (previous) pages.push(previous);
    if (previous?.nextOffset === null) return {content: 'HISTORY_COMPLETE'};
    const conversationId = String(input).match(/READ_HISTORY:([\w-]+)/)?.[1];
    return {tool: {name: 'conversation_read', args: {conversationId, limit: 4000, ...(previous ? {snapshotRef: previous.snapshotRef, offset: previous.nextOffset} : {})}}};
  }, {capabilityOptions: {platform: 'linux'}});
  t.after(() => fixture.close());
  const archive = await fixture.call('session.create');
  for (let i = 0; i < 24; i++) await fixture.send(archive.id, 'ARCHIVE_' + i);
  await fixture.restart();const reader = await fixture.call('session.create');
  const detail = await fixture.send(reader.id, 'READ_HISTORY:' + archive.id);
  assert.equal(Object.values(detail.flow.runs).at(-1).outcome, 'completed');assert.ok(pages.length > 5);
  const complete = pages.map(page => page.text).join('');assert.match(complete, /EARLY_PROOF_/);assert.match(complete, /ARCHIVE_23/);
  assert.equal(pages.at(-1).nextOffset, null);assert.equal(complete.includes('synthetic-only-key'), false);
});

test('an imported Bot library skill is resolved into the actual SDK request after Host restart', async t => {
  const fixture = await createBotCapabilityFixture(body => {
    if (body.messages.some(message => message.role === 'tool')) return {content: 'SKILL_COMPLETE'};
    const system = body.messages.find(message => message.role === 'system')?.content ?? '';
    const file = system.match(/<name>bot-runtime-proof<\/name>[\s\S]*?<location>([^<]+)<\/location>/)?.[1];
    assert.ok(file, 'SDK advertises the imported library skill');
    return {tool: {name: 'read', args: {path: file}}};
  }, {capabilityOptions: {platform: 'linux'}});
  t.after(() => fixture.close());
  const imported = await fixture.call('skills.import', {files: [{path: 'SKILL.md', contentBase64: Buffer.from('---\nname: bot-runtime-proof\ndescription: Runtime library proof\n---\nBOT_LIBRARY_RUNTIME_CONTENT').toString('base64')}]});
  await fixture.restart();
  const session = await fixture.call('session.create');
  const selected = (await fixture.call('skills', {id: session.id})).skills.find(skill => skill.skillId === imported.skill.id);
  assert.ok(selected);assert.equal(selected.source, 'library');
  const detail = await fixture.send(session.id, 'USE_LIBRARY_SKILL', {skills: [{...selected, token: selected.name}]});
  assert.equal(Object.values(detail.flow.runs).at(-1).outcome, 'completed');
  assert.match(JSON.stringify(fixture.requests), /BOT_LIBRARY_RUNTIME_CONTENT/);
});
