import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { retryingRenameSync } from '../lib/rename-retry.mjs';

const replaceJson = retryingRenameSync((from, to) => fs.renameSync(from, to));

export const BOT_PROTOCOL = 1;
export const BOT_VERSION = '1.0.0';
export const validId = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
export function fail(message, code = 'invalid') {
  throw Object.assign(new Error(message), { code });
}
export function privateDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}
export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error('Bot 数据无法读取，请保留原数据并检查磁盘或备份。');
  }
}
export function atomicJson(file, data) {
  privateDirectory(path.dirname(file));
  const tmp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(data));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (process.platform === 'win32') replaceJson(tmp, file);
  else fs.renameSync(tmp, file);
}
export function publicModel(config, revision, source = 'local') {
  const endpoint = new URL(config.baseUrl);
  endpoint.username = '';
  endpoint.password = '';
  endpoint.search = '';
  endpoint.hash = '';
  return {
    key: config.modelKey,
    providerId: config.providerId,
    name: config.name,
    model: config.model,
    baseUrl: endpoint.href,
    api: config.api,
    supportsVision: config.supportsVision === true,
    revision,
    source,
    thinkingLevel: config.thinkingLevel ?? 'default',
    thinkingFormat: config.thinkingFormat ?? null,
  };
}
export function errorView(error) {
  // Provider errors may contain credentials, HTTP headers or body excerpts. Keep those on neither side of the wire.
  return {
    ok: false,
    code: [
      'invalid',
      'missing',
      'permission',
      'conflict',
      'offline',
      'unsupported',
      'needs-review',
      'busy',
    ].includes(error?.code)
      ? error.code
      : 'failed',
    message: [
      'invalid',
      'missing',
      'permission',
      'conflict',
      'offline',
      'unsupported',
      'needs-review',
      'busy',
    ].includes(error?.code)
      ? String(error.message).slice(0, 400)
      : '操作失败，请检查服务器连接、模型配置及运行日志。',
  };
}

export const syncModelConfig = (raw) =>
  Object.fromEntries(
    [
      'modelKey',
      'providerId',
      'name',
      'model',
      'baseUrl',
      'api',
      'apiKey',
      'supportsVision',
      'thinkingLevel',
      'thinkingFormat',
      'supportsTools',
      'contextWindow',
    ]
      .filter((k) => raw[k] !== undefined)
      .map((k) => [k, raw[k]]),
  );

export const botRpcTimeout = (method, params = {}) =>
  method === 'model.sync'
    ? 30000 + Math.ceil(Math.min(50, params.models?.length ?? 1) / 4) * 60000
    : 180000;
