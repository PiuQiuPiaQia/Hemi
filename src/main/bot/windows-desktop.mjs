import net from 'node:net';
import path from 'node:path';
import {StringDecoder} from 'node:string_decoder';
import {botControlEndpoint, controlToken, validControlToken} from './control-endpoint.mjs';
import {privateDirectory} from './storage.mjs';

const LIMIT = 20 * 1024 * 1024;
const METHODS = new Set(['status', 'listAppWindows', 'windowState', 'click', 'typeText', 'setValue', 'key', 'scroll', 'findInstalledApplication', 'openApplication']);
export const desktopEndpoint = (dataDir, token, platform = process.platform) => platform === 'win32'
  ? botControlEndpoint(dataDir, platform, token) + '-desktop'
  : path.join(dataDir, 'desktop.sock');

/** An authenticated local pipe crosses from the resident S4U service to the interactive task. */
export function createWindowsDesktopClient({dataDir, endpoint = null, timeoutMs = 90000} = {}) {
  const pending = new Set();
  async function request(method, input = {}) {
    const {signal, ...params} = input;
    signal?.throwIfAborted();
    let token;try {token = controlToken(dataDir, {platform: 'win32'});} catch {throw new Error('Windows 桌面助手尚未就绪，请登录 Windows 后更新或修复 Bot 组件。');}
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(endpoint ?? desktopEndpoint(dataDir, token));pending.add(socket);
      const decoder = new StringDecoder('utf8');let body = '', settled = false;
      const finish = (error, result) => {
        if (settled) return;settled = true;pending.delete(socket);signal?.removeEventListener('abort', abort);socket.destroy();
        if (error) reject(error);else resolve(result);
      };
      const abort = () => finish(new DOMException('桌面操作已停止', 'AbortError'));
      signal?.addEventListener('abort', abort, {once: true});if (signal?.aborted) return abort();
      socket.setTimeout(timeoutMs, () => finish(new Error('Windows 桌面操作超时，结果待核对；不会自动重复执行。')));
      socket.on('error', error => finish(new Error(['ENOENT', 'ECONNREFUSED'].includes(error.code)
        ? 'Windows 桌面助手未连接，请确认该账号已登录并解锁桌面，或修复 Bot 组件。' : error.message)));
      socket.on('end', () => {if (!settled) finish(new Error('Windows 桌面通道中断，结果待核对。'));});
      socket.on('connect', () => socket.write(JSON.stringify({method, params, controlToken: token}) + '\n'));
      socket.on('data', chunk => {
        body += decoder.write(chunk);
        if (body.length > LIMIT) return finish(new Error('桌面回执超过大小限制。'));
        const end = body.indexOf('\n');if (end < 0) return;
        try {const value = JSON.parse(body.slice(0, end));finish(value.ok ? null : new Error(value.message), value.result);}
        catch (error) {finish(error);}
      });
    });
  }
  return Object.fromEntries([
    ...[...METHODS].map(name => [name, input => request(name, input)]),
    ['dispose', async () => {for (const socket of pending) socket.destroy(new Error('桌面客户端已关闭'));}],
  ]);
}

export async function startWindowsDesktopWorker({dataDir, endpoint = null, driver = null, apps = null} = {}) {
  privateDirectory(dataDir);
  const token = controlToken(dataDir, {create: true, platform: 'win32'});
  if (!driver) {
    if (process.platform !== 'win32') throw new Error('桌面助手仅支持 Windows');
    driver = (await import('../agent/gate/cua-client.mjs')).createCuaBridge();
  }
  apps ??= (await import('./windows-desktop-apps.mjs')).createWindowsDesktopApps();
  const clients = new Set();let tail = Promise.resolve();
  const server = net.createServer(socket => {
    clients.add(socket);const controller = new AbortController();const decoder = new StringDecoder('utf8');let body = '', handled = false;
    socket.on('error', () => {});socket.on('close', () => {clients.delete(socket);controller.abort();});
    socket.setTimeout(90000, () => socket.destroy());
    socket.on('data', chunk => {
      body += decoder.write(chunk);if (body.length > LIMIT) return socket.destroy();
      if (handled || !body.includes('\n')) return;handled = true;
      const work = async () => {
        try {
          const value = JSON.parse(body.slice(0, body.indexOf('\n')));
          if (!validControlToken(value.controlToken, token)) throw new Error('桌面通道认证失败。');
          if (!METHODS.has(value.method)) throw new Error('不支持的桌面操作。');
          const input = {...value.params, signal: controller.signal};controller.signal.throwIfAborted();
          const status = await apps.status({...input, refresh: value.method === 'status'});
          let result;
          if (value.method === 'status') {
            if (status.available) await driver.listAppWindows(input);
            result = status;
          }
          else {
            if (!status.available) throw new Error(status.reason || 'Windows 桌面已锁定或未登录。');
            if (value.method === 'findInstalledApplication' || value.method === 'openApplication') {
              const query = String(input.app ?? '').trim().toLowerCase();
              const catalog = await apps.list(input);
              const target = catalog.find(app => app.bundleId.toLowerCase() === query) ?? catalog.find(app => app.name.toLowerCase() === query);
              if (value.method === 'findInstalledApplication') result = target ?? null;
              else {if (!target) throw new Error('已安装应用不存在或身份已变化。');result = await apps.open(target, input);}
            } else {
              result = await driver[value.method](input);
              if (value.method === 'listAppWindows') {
                const identities = await apps.running(input);
                result = result.map(app => ({...app, bundleId: identities.get(app.pid)?.bundleId ?? ''})).filter(app => app.bundleId);
              }
            }
          }
          if (!socket.destroyed) socket.end(JSON.stringify({ok: true, result}, (_key, item) => typeof item === 'bigint' ? String(item) : item) + '\n');
        } catch (error) {if (!socket.destroyed) socket.end(JSON.stringify({ok: false, message: error.message}) + '\n');}
      };
      tail = tail.catch(() => {}).then(work);
    });
  });
  await new Promise((resolve, reject) => {server.once('error', reject);server.listen(endpoint ?? desktopEndpoint(dataDir, token), resolve);});
  return {async close() {for (const client of clients) client.destroy();await new Promise(resolve => server.close(resolve));await tail;await driver.dispose();}};
}
