import test from 'node:test';
import assert from 'node:assert/strict';

import { notifyViaAppleScript } from './system-notification.mjs';

test('AppleScript 兜底：文本走 argv 传参，不拼进脚本', async () => {
  const calls = [];
  const ok = await notifyViaAppleScript({
    title: '任务 A',
    body: '任务已完成：整理下载文件夹',
    run: (file, args, options, callback) => {
      calls.push({ file, args, options });
      callback(null);
    },
  });
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'osascript');
  // 前三对是脚本本体，最后两个参数是标题与正文（用户文本不经脚本拼接）。
  assert.deepEqual(calls[0].args.slice(-2), ['任务 A', '任务已完成：整理下载文件夹']);
  assert.equal(calls[0].args[0], '-e');
  assert.match(calls[0].args[1], /on run argv/);
});

test('AppleScript 兜底：空白折叠、超长截断、空标题回退品牌名', async () => {
  let received = null;
  await notifyViaAppleScript({
    title: '   ',
    body: `第一行\n第二行\t${'x'.repeat(400)}`,
    run: (_file, args, _options, callback) => { received = args.slice(-2); callback(null); },
  });
  assert.equal(received[0], 'Hemi');
  assert.equal(received[1].length, 200);
  assert.match(received[1], /^第一行 第二行 x/);
});

test('AppleScript 兜底失败只落日志、返回 false', async () => {
  const warnings = [];
  const ok = await notifyViaAppleScript({
    title: 'Hemi',
    body: '任务已完成',
    log: { warn: message => warnings.push(message) },
    run: (_file, _args, _options, callback) => callback(new Error('not authorized')),
  });
  assert.equal(ok, false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /not authorized/);
});
