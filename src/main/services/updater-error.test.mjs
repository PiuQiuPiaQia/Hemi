import assert from 'node:assert/strict';
import test from 'node:test';

import { formatUpdateError } from './updater-error.mjs';

const VERBOSE_ERROR = '502 Bad Gateway\n"method: GET url: http://127.0.0.1:61336/latest-mac.yml?noCache=abc\\n\\n Data:\\n 列 release 失败（403）\\n"\nHeaders: {"connection":"keep-alive"}';

test('完整 HTTP 错误、URL 和响应头不进入用户提示', () => {
  assert.equal(formatUpdateError(new Error(VERBOSE_ERROR)), '检查更新失败：更新服务暂时不可用，请稍后重试。');
  const cases = [
    [Object.assign(new Error('Forbidden'), { statusCode: 403 }), '更新服务暂时不可用'],
    [Object.assign(new Error('Not Found'), { statusCode: 404 }), '更新文件暂不可用'],
    [Object.assign(new Error('Too Many Requests'), { statusCode: 429 }), '请求过于频繁'],
    [new Error('403 Forbidden\nAPI rate limit exceeded'), '请求过于频繁'],
    [Object.assign(new Error('connect'), { code: 'ECONNRESET' }), '网络连接失败'],
    [new Error('net::ERR_INTERNET_DISCONNECTED at https://github.com/x'), '网络连接失败'],
    [Object.assign(new Error('No space'), { code: 'ENOSPC' }), '磁盘空间不足'],
    [Object.assign(new Error('Permission denied'), { code: 'EACCES' }), '没有写入权限'],
    [Object.assign(new Error('corrupt bytes'), { code: 'ERR_CHECKSUM_MISMATCH' }), '安装包校验失败'],
    [Object.assign(new Error('Cannot find channel: verbose stack'), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' }), '更新文件暂不可用'],
    [new Error('internal details\nHeaders: private'), '请稍后重试或前往发布页下载'],
  ];
  for (const [error, expected] of cases) {
    const message = formatUpdateError(error);
    assert.ok(message.includes(expected), `${error.message}: ${message}`);
    assert.ok(message.length < 65);
    assert.doesNotMatch(message, /https?:|Headers:|\\n|\n|stack/);
  }
});

test('失败动作明确区分检查、下载与安装，不靠错误正文猜测', () => {
  for (const operation of ['检查更新', '下载更新', '安装更新']) {
    assert.equal(formatUpdateError(new Error(VERBOSE_ERROR), operation), `${operation}失败：更新服务暂时不可用，请稍后重试。`);
  }
  assert.equal(formatUpdateError(new Error('unexpected error: https://example.com/404/502.zip')), '检查更新失败：请稍后重试或前往发布页下载。');
});
