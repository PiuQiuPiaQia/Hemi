import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const source = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'floating-surface.mjs'),
  'utf8',
);

// 回归（2026-09-20 Dock 图标消失）：macOS 上 setVisibleOnAllWorkspaces(true,
// { visibleOnFullScreen: true }) 会把应用注册成辅助应用（lsappinfo type 翻成
// UIElement），Dock 图标随之消失；实测设完行为后立刻 app.dock.show() 即可恢复
// 且不反弹。悬浮窗的三条创建路径必须全部走带重申的助手，不得绕开。
test('悬浮窗的全空间可见不得弄丢 Dock 图标', () => {
  const rawCalls = [...source.matchAll(/\.setVisibleOnAllWorkspaces\(/g)].length;
  assert.equal(
    rawCalls,
    1,
    'setVisibleOnAllWorkspaces 只允许出现在 showOnAllWorkspacesKeepingDock 助手里',
  );

  const helperMentions = [...source.matchAll(/showOnAllWorkspacesKeepingDock\(/g)].length;
  assert.ok(
    helperMentions >= 4,
    '助手应被三个窗口创建点调用（定义 1 次 + 调用 3 次）',
  );

  const helperBody = source.match(/function showOnAllWorkspacesKeepingDock[\s\S]*?\n\}/);
  assert.ok(helperBody, '缺少 showOnAllWorkspacesKeepingDock 助手');
  assert.match(
    helperBody[0],
    /app\.dock\?\.show\(\)/,
    '助手必须在设完全空间可见后重申 dock.show()',
  );
});
