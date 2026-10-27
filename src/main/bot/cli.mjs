#!/usr/bin/env node
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { once } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { errorView, privateDirectory, botRpcTimeout } from './storage.mjs';
import { botControlEndpoint, controlToken, validControlToken } from './control-endpoint.mjs';
import {serveRpcStream} from './rpc-stream.mjs';

const dataDir =
  process.env.HEMI_BOT_DATA_DIR ||
  path.join(os.homedir(), '.local/share/hemi-bot/data');
const controlSocket = () => botControlEndpoint(dataDir, process.platform, controlToken(dataDir));
const limit = 40 * 1024 * 1024;
export async function rpc(
  request,
  { socket = controlSocket(), timeoutMs = 180000, token = controlToken(dataDir) } = {},
) {
  const client = net.createConnection(socket);
  const decoder = new StringDecoder('utf8');
  let body = '';
  const response = new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        const value = JSON.parse(body);
        if (value.ok === false) reject(Object.assign(new Error(value.message), {code:value.code}));
        else resolve(value.result);
      } catch (error) { reject(error); }
      finally { client.destroy(); }
    };
    client.setTimeout(timeoutMs, () =>
      client.destroy(new Error('Bot 请求超时，结果待核对。')),
    );
    client.on('error', reject);
    client.on('data', (chunk) => {
      body += decoder.write(chunk);
      if (body.length > limit)
        client.destroy(new Error('Bot 回执超过大小限制。'));
      else if (body.includes('\n')) finish();
    });
    client.on('end', () => {
      body += decoder.end();
      finish();
    });
  });
  client.on('connect', () => {
    const payload = JSON.stringify({...request, ...(token ? {controlToken: token} : {})}) + '\n';
    if (process.platform === 'win32') client.write(payload); else client.end(payload);
  });
  return response;
}
export async function serve(options = {}) {
  process.umask(0o077);
  privateDirectory(dataDir);
  const token = controlToken(dataDir, {create: true});
  const socketPath = controlSocket();
  // An existing live socket belongs to another Host. Never unlink it and create a second scheduler.
  if (process.platform === 'win32' || fs.existsSync(socketPath)) {
    try {
      await rpc({ method: 'handshake' }, { timeoutMs: 2000 });
      throw Object.assign(new Error('Bot 已在运行。'), { code: 'busy' });
    } catch (error) {
      if (error.code === 'busy') throw error;
      if (!['ECONNREFUSED', 'ENOENT'].includes(error.code)) throw error;
      if (process.platform !== 'win32') fs.unlinkSync(socketPath);
    }
  }
  const { createBotHost } = await import('./host.mjs');
  const host = await createBotHost({ dataDir, ...options });
  const clients = new Set();
  const server = net.createServer({ allowHalfOpen: true }, (client) => {
    clients.add(client);client.once('close',()=>clients.delete(client));
    const decoder = new StringDecoder('utf8');
    let body = '';
    let handling = false;
    client.setTimeout(180000, () => client.destroy());
    client.on('error', () => {});
    client.on('data', (chunk) => {
      body += decoder.write(chunk);
      if (body.length > limit) client.destroy();
      else if (body.includes('\n')) handleRequest();
    });
    // Windows named pipes have no POSIX write-half close. Delimit requests
    // explicitly; accept EOF as well for already deployed Linux CLI clients.
    const handleRequest = () => {
      if (handling || client.destroyed) return;
      handling = true;
      void (async () => {
        try {
          const value = JSON.parse(body);
          if (!validControlToken(value.controlToken, token)) throw Object.assign(new Error('Bot 控制通道认证失败。'), {code: 'permission'});
          client.setTimeout(botRpcTimeout(value.method, value.params));
          if (value.method === 'events.watch') {
            client.setTimeout(0);
            const unsubscribe=host.watch(value.params,frame=>{if(client.destroyed || client.writableLength>2*1024*1024)throw new Error('Slow subscriber');client.write(JSON.stringify(frame)+'\n');},()=>client.destroy(),{clientId:value.clientId});
            const heartbeat=setInterval(()=>{if(!client.destroyed)client.write(JSON.stringify({type:'heartbeat'})+'\n');},20000);heartbeat.unref?.();
            client.once('close',()=>{clearInterval(heartbeat);unsubscribe();});
            return;
          }
          const result = await host.request(value.method, value.params, {clientId:value.clientId});
          client.end(JSON.stringify({ ok: true, result }) + '\n');
        } catch (error) {
          client.end(JSON.stringify(errorView(error)) + '\n');
        }
      })();
    };
    client.on('end', () => { body += decoder.end(); handleRequest(); });
  });
  try {
    server.listen(socketPath);
    await once(server, 'listening');
    if (process.platform !== 'win32') fs.chmodSync(socketPath, 0o600);
  } catch (error) { await host.close(); throw error; }
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    for(const client of clients)client.destroy();
    await host.close();
    await new Promise((resolve) => server.close(resolve));
    try {
      if (process.platform !== 'win32') fs.unlinkSync(socketPath);
    } catch {}
  };
  return { host, server, close };
}
if (
  process.argv[1] &&
  fs.existsSync(process.argv[1]) &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(import.meta.filename)
) {
  if (process.argv[2] === 'serve') {
    if (!['linux', 'win32'].includes(process.platform) && !process.env.HEMI_BOT_ISOLATED_TEST)
      throw new Error('Bot 常驻 Host 仅支持 Linux 和 Windows。');
    const instance = await serve({
      allowLoopbackModels: process.env.HEMI_BOT_ISOLATED_TEST === '1',
    });
    for (const signal of ['SIGINT', 'SIGTERM'])
      process.once(signal, () => {
        void instance.close().then(() => process.exit(0));
      });
  } else if (process.argv[2] === 'watch') {
    process.stdin.setEncoding('utf8');
    let body='';for await(const chunk of process.stdin){body+=chunk;if(body.length>16384)throw new Error('订阅请求过大');}
    const value=JSON.parse(body), client=net.createConnection(controlSocket());
    client.on('connect',()=>client.write(JSON.stringify({method:'events.watch',params:value.params,clientId:value.clientId,controlToken:controlToken(dataDir)})+'\n'));
    client.on('data',chunk=>{if(!process.stdout.write(chunk))client.pause();});
    process.stdout.on('drain',()=>client.resume());
    process.stdout.on('error',()=>client.destroy());
    client.on('error',()=>{process.exitCode=1;});
    client.on('end',()=>{process.exitCode=1;});
  } else if (process.argv[2] === 'rpc-stream') {
    process.stdout.on('error', () => process.stdin.destroy());
    await serveRpcStream({input: process.stdin, output: process.stdout, request: async value => ({
      ok: true, result: await rpc(value, {timeoutMs: botRpcTimeout(value.method, value.params)}),
    })});
  } else if (process.argv[2] === 'rpc') {
    process.stdin.setEncoding('utf8');
    let body = '';
    for await (const chunk of process.stdin) {
      body += chunk;
      if (body.length > limit) throw new Error('请求超过大小限制');
    }
    try {
      process.stdout.write(
        JSON.stringify({
          ok: true,
          result: await ((value) =>
            rpc(value, {
              timeoutMs: botRpcTimeout(value.method, value.params),
            }))(JSON.parse(body)),
        }),
      );
    } catch (error) {
      const problem = ['ECONNREFUSED', 'ENOENT'].includes(error.code)
        ? Object.assign(
            new Error(
              '云端 Bot 服务未响应，请启动已安装的 Bot 或检查服务状态。',
            ),
            { code: 'offline' },
          )
        : error;
      process.stdout.write(JSON.stringify(errorView(problem)));
      process.exitCode = 1;
    }
  } else throw new Error('Usage: node cli.mjs serve|rpc|rpc-stream|watch');
}
