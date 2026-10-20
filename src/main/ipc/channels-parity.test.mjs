import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { IPC } from '../../shared/ipc-channels.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const preloadPath = path.join(here, '..', '..', 'preload', 'index.cjs');

/** 展平 IPC 常量为 channel 字符串集合。 */
function channelValues(node) {
  const values = [];
  for (const value of Object.values(node)) {
    if (typeof value === 'string') values.push(value);
    else values.push(...channelValues(value));
  }
  return values;
}

test('preload 内联的 channel 字符串与 shared/ipc-channels 保持一致', async () => {
  const source = await readFile(preloadPath, 'utf8');
  const declared = new Set(channelValues(IPC));

  // preload 源码里所有 '域:动作' 形态的单引号字符串。
  const inline = new Set();
  for (const match of source.matchAll(/'([a-z]+(?:-[a-z]+)*:[a-z-]+)'/g)) {
    inline.add(match[1]);
  }

  // 沙箱 preload 不能 import 共享模块（见 ipc-channels.mjs 头注释），
  // 只能内联字符串——所以这里做单向断言：preload 用到的每个 channel
  // 必须都在契约里声明过，防止两侧悄悄漂移。
  assert.ok(inline.size >= 30, `preload 里 channel 数量异常: ${inline.size}`);
  const undeclared = [...inline].filter((channel) => !declared.has(channel));
  assert.deepEqual(
    undeclared,
    [],
    `preload 使用了未在 src/shared/ipc-channels.mjs 声明的通道: ${undeclared.join(', ')}`,
  );
});
