#!/usr/bin/env node
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { once } from 'node:events';
import { errorView, privateDirectory, botRpcTimeout } from './storage.mjs';

const dataDir =
  process.env.HEMI_BOT_DATA_DIR ||
  path.join(os.homedir(), '.local/share/hemi-bot/data');
const socketPath = path.join(dataDir, 'control.sock');
const limit = 40 * 1024 * 1024;
export async function rpc(
  request,
  { socket = socketPath, timeoutMs = 180000 } = {},
) {
  const client = net.createConnection(socket);
  let body = '';
  const response = new Promise((resolve, reject) => {
    client.setTimeout(timeoutMs, () =>
      client.destroy(new Error('Bot 请求超时，结果待核对。')),
    );
    client.on('error', reject);
    client.on('data', (chunk) => {
      body += chunk.toString('utf8');
      if (body.length > limit)
        client.destroy(new Error('Bot 回执超过大小限制。'));
    });
    client.on('end', () => {
      try {
        const value = JSON.parse(body);
        if (value.ok === false)
          reject(Object.assign(new Error(value.message), { code: value.code }));
        else resolve(value.result);
      } catch (error) {
        reject(error);
      }
    });
  });
  client.on('connect', () => client.end(JSON.stringify(request) + '\n'));
  return response;
}
export async function serve(options = {}) {
  process.umask(0o077);
  privateDirectory(dataDir);
  // An existing live socket belongs to another Host. Never unlink it and create a second scheduler.
  if (fs.existsSync(socketPath)) {
    try {
      await rpc({ method: 'handshake' }, { timeoutMs: 2000 });
      throw Object.assign(new Error('Bot 已在运行。'), { code: 'busy' });
    } catch (error) {
      if (error.code === 'busy') throw error;
      if (!['ECONNREFUSED', 'ENOENT'].includes(error.code)) throw error;
      fs.unlinkSync(socketPath);
    }
  }
  const { createBotHost } = await import('./host.mjs');
  const host = await createBotHost({ dataDir, ...options });
  const clients = new Set();
  const server = net.createServer({ allowHalfOpen: true }, (client) => {
    clients.add(client);client.once('close',()=>clients.delete(client));
    let body = '';
    client.setTimeout(180000, () => client.destroy());
    client.on('error', () => {});
    client.on('data', (chunk) => {
      body += chunk.toString('utf8');
      if (body.length > limit) client.destroy();
    });
    client.on('end', () => {
      void (async () => {
        try {
          const value = JSON.parse(body);
          client.setTimeout(botRpcTimeout(value.method, value.params));
          if (value.method === 'events.watch') {
            client.setTimeout(0);
            const unsubscribe=host.watch(value.params,frame=>{if(client.destroyed || client.writableLength>2*1024*1024)throw new Error('Slow subscriber');client.write(JSON.stringify(frame)+'\n');},()=>client.destroy(),{clientId:value.clientId});
            const heartbeat=setInterval(()=>{if(!client.destroyed)client.write(JSON.stringify({type:'heartbeat'})+'\n');},20000);heartbeat.unref?.();
            client.once('close',()=>{clearInterval(heartbeat);unsubscribe();});
            return;
          }
          const result = await host.request(value.method, value.params, {clientId:value.clientId});
          client.end(JSON.stringify({ ok: true, result }));
        } catch (error) {
          client.end(JSON.stringify(errorView(error)));
        }
      })();
    });
  });
  server.listen(socketPath);
  await once(server, 'listening');
  fs.chmodSync(socketPath, 0o600);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    for(const client of clients)client.destroy();
    await host.close();
    await new Promise((resolve) => server.close(resolve));
    try {
      fs.unlinkSync(socketPath);
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
    if (process.platform !== 'linux' && !process.env.HEMI_BOT_ISOLATED_TEST)
      throw new Error('Bot 常驻 Host 仅支持 Linux。');
    const instance = await serve({
      allowLoopbackModels: process.env.HEMI_BOT_ISOLATED_TEST === '1',
    });
    for (const signal of ['SIGINT', 'SIGTERM'])
      process.once(signal, () => {
        void instance.close().then(() => process.exit(0));
      });
  } else if (process.argv[2] === 'watch') {
    let body='';for await(const chunk of process.stdin){body+=chunk;if(body.length>16384)throw new Error('订阅请求过大');}
    const value=JSON.parse(body), client=net.createConnection(socketPath);
    client.on('connect',()=>client.end(JSON.stringify({method:'events.watch',params:value.params,clientId:value.clientId})));
    client.on('data',chunk=>{if(!process.stdout.write(chunk))client.pause();});
    process.stdout.on('drain',()=>client.resume());
    process.stdout.on('error',()=>client.destroy());
    client.on('error',()=>{process.exitCode=1;});
    client.on('end',()=>{process.exitCode=1;});
  } else if (process.argv[2] === 'rpc') {
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
  } else throw new Error('Usage: node cli.mjs serve|rpc');
}
