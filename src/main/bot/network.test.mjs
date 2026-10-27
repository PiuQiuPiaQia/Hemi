import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const repo = path.resolve(import.meta.dirname, '../../..');
const network = new URL('./network.mjs', import.meta.url).href;
const hostModule = new URL('./host.mjs', import.meta.url).href;

test('a real Bot Host prefers direct connections, falls back for connection failures after SDK imports, and honors NO_PROXY', { timeout: 40000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-proxy-host-'));
  const targets = [], paths = [], sockets = new Set();
  const backend = http.createServer((req, res) => {
    paths.push(req.url); res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"fixture"}');
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const proxy = http.createServer((req, res) => {
    targets.push(new URL(req.url).host);
    const upstream = http.request({ hostname: '127.0.0.1', port: backend.address().port, path: new URL(req.url).pathname }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    upstream.on('error', () => res.destroy()); req.pipe(upstream);
  });
  proxy.on('connect', (req, socket, head) => {
    targets.push(req.url); sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    const upstream = net.connect(backend.address().port, '127.0.0.1');
    sockets.add(upstream); upstream.once('close', () => sockets.delete(upstream));
    upstream.once('connect', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    socket.on('error', () => upstream.destroy()); upstream.on('error', () => socket.destroy());
    socket.once('close', () => upstream.destroy());
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const unavailable = net.createServer();
  await new Promise(resolve => unavailable.listen(0, '127.0.0.1', resolve));
  const unavailableOrigin = `127.0.0.1:${unavailable.address().port}`;
  await new Promise(resolve => unavailable.close(resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    backend.closeAllConnections(); proxy.closeAllConnections();
    await Promise.all([new Promise(resolve => backend.close(resolve)), new Promise(resolve => proxy.close(resolve))]);
    await fs.rm(root, { recursive: true, force: true });
  });
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  const env = { ...process.env, NODE_USE_ENV_PROXY: '1', HTTP_PROXY: proxyUrl, http_proxy: proxyUrl,
    HTTPS_PROXY: proxyUrl, https_proxy: proxyUrl, NO_PROXY: 'localhost', no_proxy: 'localhost', HEMI_BOT_NETWORK_MODE: '',
    HEMI_USER_DATA_DIR: path.join(root, 'profile') };
  delete env.ALL_PROXY; delete env.all_proxy;
  const code = `
    await import('@earendil-works/pi-coding-agent');
    const {createBotHost} = await import(${JSON.stringify(hostModule)});
    const host = await createBotHost({dataDir:${JSON.stringify(path.join(root, 'data'))},defaultDir:${JSON.stringify(path.join(root, 'workspace'))}});
    try {
      const native = await fetch('http://${unavailableOrigin}/native',{signal:AbortSignal.timeout(5000)});
      await native.body.cancel();
      const {fetch:sdkFetch} = await import('undici');
      const sdk = await sdkFetch('http://${unavailableOrigin}/sdk',{signal:AbortSignal.timeout(5000)});
      await sdk.body.cancel();
      const preferred = await fetch('http://127.0.0.1:${backend.address().port}/preferred',{signal:AbortSignal.timeout(5000)});
      await preferred.body.cancel();
      const direct = await fetch('http://localhost:${backend.address().port}/direct',{signal:AbortSignal.timeout(5000)});
      await direct.body.cancel();
      let bypassFailed=false;
      try{await fetch('http://localhost:${new URL('http://' + unavailableOrigin).port}/bypassed',{signal:AbortSignal.timeout(5000)});}catch{bypassFailed=true;}
      console.log(JSON.stringify({native:native.status,sdk:sdk.status,preferred:preferred.status,direct:direct.status,bypassFailed}));
    } finally {await host.close();}
  `;
  const flags = process.allowedNodeEnvironmentFlags.has('--use-env-proxy') ? ['--use-env-proxy'] : [];
  const result = await exec(process.execPath, [...flags, '--input-type=module', '-e', code], { cwd: repo, env, timeout: 30000 });
  assert.deepEqual(JSON.parse(result.stdout.trim()), { native: 401, sdk: 401, preferred: 401, direct: 401, bypassFailed: true });
  assert.deepEqual(paths.sort(), ['/direct', '/native', '/preferred', '/sdk']);
  assert.ok(targets.length > 0 && targets.every(target => target === unavailableOrigin), 'reachable and NO_PROXY origins stay direct');
});

test('Bot proxy setup preserves disabled networking and reports invalid proxy configuration without credentials', async () => {
  const code = `
    const {configureBotNetwork}=await import(${JSON.stringify(network)});
    const {getGlobalDispatcher}=await import('undici');
    const original=getGlobalDispatcher();
    const disabled=configureBotNetwork();
    process.env.NODE_USE_ENV_PROXY='1';
    let message;try{configureBotNetwork();}catch(error){message=error.message;}
    console.log(JSON.stringify({disabled,unchanged:original===getGlobalDispatcher(),message}));
  `;
  const result = await exec(process.execPath, ['--input-type=module', '-e', code], {
    cwd: repo, env: { ...process.env, HEMI_BOT_NETWORK_MODE: '', NODE_USE_ENV_PROXY: '0', HTTP_PROXY: 'http://user:fixture-secret@', http_proxy: 'http://user:fixture-secret@', HTTPS_PROXY: '', https_proxy: '' },
  });
  const value = JSON.parse(result.stdout.trim());
  assert.equal(value.disabled, false); assert.equal(value.unchanged, true);
  assert.match(value.message, /Bot 代理配置无效/); assert.ok(!result.stdout.includes('fixture-secret'));
});

async function directFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-network-policy-'));
  const requests = [], tunnels = [], sockets = new Set();
  const backend = http.createServer((req, res) => {
    requests.push({ path: req.url, method: req.method });
    if (req.url === '/interrupted') {
      req.resume(); req.on('end', () => req.socket.destroy()); return;
    }
    res.writeHead(Number(req.url.slice(1)) || 200); res.end('fixture');
  });
  const proxy = http.createServer();
  proxy.on('connect', (req, socket) => {
    tunnels.push(req.url); socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n');
  });
  const blackhole = net.createServer();
  for (const server of [backend, proxy, blackhole]) {
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  }
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([backend, proxy, blackhole].map(server => new Promise(resolve => server.close(resolve))));
    await fs.rm(root, { recursive: true, force: true });
  });
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  return {
    url: `http://127.0.0.1:${backend.address().port}`, stalledUrl: `https://127.0.0.1:${blackhole.address().port}`,
    requests, tunnels,
    async run(code, overrides = {}) {
      const env = { ...process.env, HTTP_PROXY: proxyUrl, http_proxy: proxyUrl, HTTPS_PROXY: proxyUrl, https_proxy: proxyUrl,
        NO_PROXY: '', no_proxy: '', NODE_USE_ENV_PROXY: '1', HEMI_BOT_NETWORK_MODE: 'auto', HEMI_USER_DATA_DIR: root, ...overrides };
      delete env.ALL_PROXY; delete env.all_proxy;
      const source = `
        const {configureBotNetwork}=await import(${JSON.stringify(network)});
        const {getGlobalDispatcher,fetch:sdkFetch}=await import('undici');
        ${code}
        await getGlobalDispatcher().destroy();
      `;
      const result = await exec(process.execPath, ['--input-type=module', '-e', source], { cwd: repo, env, timeout: 15000 });
      return JSON.parse(result.stdout.trim());
    },
  };
}

test('auto mode works with a stopped proxy; direct mode and an unconfigured Bot need no proxy', async t => {
  const f = await directFixture(t);
  for (const overrides of [
    { HTTP_PROXY: 'http://127.0.0.1:1', http_proxy: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', https_proxy: 'http://127.0.0.1:1' },
    { HEMI_BOT_NETWORK_MODE: 'direct' },
    { HEMI_BOT_NETWORK_MODE: '', NODE_USE_ENV_PROXY: '0', HTTP_PROXY: '', http_proxy: '', HTTPS_PROXY: '', https_proxy: '' },
  ]) {
    const result = await f.run(`
      configureBotNetwork();
      const a=await fetch(${JSON.stringify(f.url)}), b=await sdkFetch(${JSON.stringify(f.url)});
      await a.body.cancel();await b.body.cancel();
      console.log(JSON.stringify({native:a.status,sdk:b.status}));
    `, overrides);
    assert.deepEqual(result, { native: 200, sdk: 200 });
  }
  assert.equal(f.requests.length, 6); assert.equal(f.tunnels.length, 0);
});

test('proxy mode explicitly uses the configured proxy for a directly reachable origin', async t => {
  const f = await directFixture(t);
  const result = await f.run(`
    configureBotNetwork();
    let failed=false;try{await fetch(${JSON.stringify(f.url)});}catch{failed=true;}
    console.log(JSON.stringify({failed}));
  `, { HEMI_BOT_NETWORK_MODE: 'proxy' });
  assert.equal(result.failed, true);
  assert.deepEqual(f.tunnels, [new URL(f.url).host]); assert.equal(f.requests.length, 0);
});

test('auto mode does not retry HTTP authorization, permission, quota or an interrupted POST through the proxy', async t => {
  const f = await directFixture(t);
  const result = await f.run(`
    configureBotNetwork();
    const statuses=[];
    for(const code of [401,403,429]){
      const response=await fetch(${JSON.stringify(f.url)}+'/'+code);statuses.push(response.status);await response.body.cancel();
    }
    let interrupted=false;
    try{await fetch(${JSON.stringify(f.url + '/interrupted')},{method:'POST',body:'synthetic-model-request'});}catch{interrupted=true;}
    console.log(JSON.stringify({statuses,interrupted}));
  `);
  assert.deepEqual(result, { statuses: [401, 403, 429], interrupted: true });
  assert.deepEqual(f.requests.map(r => r.path), ['/401', '/403', '/429', '/interrupted']);
  assert.equal(f.requests.at(-1).method, 'POST'); assert.equal(f.tunnels.length, 0);
});

test('auto mode bounds a stalled TLS handshake before attempting the proxy', { timeout: 15000 }, async t => {
  const f = await directFixture(t);
  const result = await f.run(`
    configureBotNetwork();
    const start=Date.now();let failed=false;
    try{await fetch(${JSON.stringify(f.stalledUrl)},{signal:AbortSignal.timeout(10000)});}catch{failed=true;}
    console.log(JSON.stringify({failed,elapsed:Date.now()-start}));
  `);
  assert.equal(result.failed, true); assert.ok(result.elapsed >= 2500 && result.elapsed < 8000, JSON.stringify(result));
  assert.deepEqual(f.tunnels, [new URL(f.stalledUrl).host]); assert.equal(f.requests.length, 0);
});

test('invalid explicit modes and missing forced-proxy configuration give controlled errors', async t => {
  const f = await directFixture(t);
  for (const [overrides, expected] of [
    [{ HEMI_BOT_NETWORK_MODE: 'fixture-secret' }, /Bot 网络模式无效/],
    [{ HEMI_BOT_NETWORK_MODE: 'proxy', HTTP_PROXY: '', http_proxy: '', HTTPS_PROXY: '', https_proxy: '' }, /Bot 尚未配置代理/],
  ]) {
    const result = await f.run(`
      let message;try{configureBotNetwork();}catch(error){message=error.message;}
      console.log(JSON.stringify({message}));
    `, overrides);
    assert.match(result.message, expected); assert.ok(!result.message.includes('fixture-secret'));
  }
});
