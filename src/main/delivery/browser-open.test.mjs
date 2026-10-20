import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createBrowserFileOpener, parseBrowserBundle } from './browser-open.mjs';
import { createArtifactPreviewOpener } from './register.mjs';

/** 记录调用的 exec 桩：按命令名返回可编排的结果。 */
function recordingExec(script) {
  const calls = [];
  const exec = async (command, args) => {
    calls.push({ command, args });
    const step = script[command];
    if (!step) throw new Error(`unexpected exec: ${command}`);
    if (step.error) throw step.error;
    return { stdout: step.stdout ?? '' };
  };
  return { exec, calls };
}

const plistJson = (handlers) => JSON.stringify({ LSHandlers: handlers });

test('parseBrowserBundle：https 优先于 http，缺失/脏数据返回 null', () => {
  const handlers = [
    { LSHandlerURLScheme: 'http', LSHandlerRoleAll: 'com.http.first' },
    { LSHandlerURLScheme: 'https', LSHandlerRoleAll: 'com.https.wins' },
  ];
  assert.equal(parseBrowserBundle(handlers), 'com.https.wins');
  assert.equal(parseBrowserBundle([{ LSHandlerURLScheme: 'http', LSHandlerRoleAll: 'com.only.http' }]), 'com.only.http');
  assert.equal(parseBrowserBundle([{ LSHandlerURLScheme: 'ftp', LSHandlerRoleAll: 'x' }]), null);
  assert.equal(parseBrowserBundle([{ LSHandlerURLScheme: 'https', LSHandlerRoleAll: '  ' }]), null);
  assert.equal(parseBrowserBundle(null), null);
});

test('openInBrowser：解析默认浏览器后用 open -b 定向 file:// URL（含中文转义）', { skip: process.platform === 'win32' ? '默认浏览器定向是 mac 实现（plutil/open -b），win 走 openExternal 兜底未实现' : false }, async () => {
  const { exec, calls } = recordingExec({
    plutil: { stdout: plistJson([{ LSHandlerURLScheme: 'https', LSHandlerRoleAll: 'com.google.chrome' }]) },
    open: {},
  });
  const openExternal = async () => {
    throw new Error('should not be called');
  };
  const openPath = async () => '';
  const openInBrowser = createBrowserFileOpener({ exec, openExternal, openPath });

  const result = await openInBrowser('/tmp/下载/报价 对比.md');
  assert.deepEqual(result, { ok: true });
  const openCall = calls.find((call) => call.command === 'open');
  assert.equal(openCall.args[0], '-b');
  assert.equal(openCall.args[1], 'com.google.chrome');
  assert.equal(openCall.args[2], 'file:///tmp/%E4%B8%8B%E8%BD%BD/%E6%8A%A5%E4%BB%B7%20%E5%AF%B9%E6%AF%94.md');
});

test('openInBrowser：bundle 解析失败 → openExternal(file://) 兜底，openPath 不动', { skip: process.platform === 'win32' ? '同上：mac 实现' : false }, async () => {
  const { exec, calls } = recordingExec({ plutil: { error: new Error('no such file') }, open: {} });
  const tried = [];
  const openInBrowser = createBrowserFileOpener({
    exec,
    openExternal: async (url) => {
      tried.push(['external', url]);
    },
    openPath: async () => {
      tried.push(['openPath']);
      return '';
    },
  });
  const result = await openInBrowser('/tmp/a.txt');
  assert.equal(result.ok, true);
  assert.deepEqual(tried, [['external', 'file:///tmp/a.txt']]);
  assert.equal(calls.filter((call) => call.command === 'open').length, 0);
});

test('openInBrowser：open -b 与 openExternal 都失败 → openPath 如实回报结果', async () => {
  const { exec } = recordingExec({
    plutil: { stdout: plistJson([{ LSHandlerURLScheme: 'https', LSHandlerRoleAll: 'com.x' }]) },
    open: { error: new Error('bundle gone') },
  });
  const openInBrowser = createBrowserFileOpener({
    exec,
    openExternal: async () => {
      throw new Error('file:// rejected');
    },
    openPath: async () => '应用不存在',
  });
  assert.deepEqual(await openInBrowser('/tmp/a.txt'), { ok: false, message: '打开文件失败：应用不存在' });
});

test('openArtifactPreviewFile：按档案寻址，未登记/跨任务/非文件/缺失/未支持格式一律拒绝', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'hemi-preview-open-'));
  try {
    writeFileSync(path.join(home, 'notes.md'), '# 说明');
    writeFileSync(path.join(home, 'data.csv'), 'a,b');
    const history = {
      getRecord(taskId) {
        if (taskId !== 't1') return null;
        return {
          deliverables: [
            { id: 'a1', kind: 'file', path: path.join(home, 'notes.md') },
            { id: 'a2', kind: 'file', path: path.join(home, 'data.csv') },
            { id: 'a3', kind: 'file', path: path.join(home, 'moved.md') },
            { id: 'a4', kind: 'link', url: 'https://example.com' },
          ],
        };
      },
    };
    const opened = [];
    const opener = createArtifactPreviewOpener({
      history,
      openInBrowser: async (filePath) => {
        opened.push(filePath);
        return { ok: true };
      },
    });

    // 未登记 ID / 别的任务 / 链接产物：都到不了 openInBrowser。
    assert.equal((await opener.openArtifactPreviewFile('t1', 'nope')).ok, false);
    assert.equal((await opener.openArtifactPreviewFile('t2', 'a1')).ok, false);
    assert.equal((await opener.openArtifactPreviewFile('t1', 'a4')).ok, false);
    // 未支持格式（csv 不在预览清单）。
    assert.match((await opener.openArtifactPreviewFile('t1', 'a2')).message, /不支持在浏览器打开/);
    // 文件被移走：存在性查证拦截。
    assert.match((await opener.openArtifactPreviewFile('t1', 'a3')).message, /不在原位置/);
    assert.deepEqual(opened, []);

    // 真实登记的 md：主进程按档案路径转给浏览器打开通路。
    assert.deepEqual(await opener.openArtifactPreviewFile('t1', 'a1'), { ok: true });
    assert.deepEqual(opened, [path.join(home, 'notes.md')]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
