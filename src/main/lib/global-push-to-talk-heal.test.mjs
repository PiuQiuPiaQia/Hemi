import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// global-push-to-talk 依赖 Electron，无法在 node --test 下加载执行（同
// llm-ipc-scope.test.mjs 的先例）；自愈看门狗的行为核心（退避取值）已在
// heal-backoff.test.mjs 单测。这里用源码文本断言锁住接线形态，防两处回归：
// ①看门狗退回固定 setInterval 无限重建（2026-09-30 晚间审计实锤：纯语音
//   用户每 10 秒重建一次 tap，永不收敛）；
// ②用户手势（设置页开关/去授权/输入监控引导）丢失梯次重置，封顶后无法恢复。

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(here, 'global-push-to-talk.mjs');

function functionBody(source, name, endMarker) {
  const start = source.indexOf(`function ${name}`);
  assert.ok(start >= 0, `找不到函数 ${name}（实现是否被删改？）`);
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, `找不到 ${name} 的结束锚点 ${endMarker}`);
  return source.slice(start, end);
}

test('自愈看门狗：一次性 setTimeout + 退避取值，无固定 setInterval', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const body = functionBody(source, 'scheduleHealRestart', 'function scheduleTrustPoll');

  assert.ok(body.includes('setTimeout('), '看门狗必须用一次性 setTimeout 排下次退避');
  assert.ok(!body.includes('setInterval'), '看门狗不得回退到固定 interval 轮询重建');
  assert.ok(body.includes('nextHealRestartDelayMs('), '退避间隔必须来自 heal-backoff 梯次');
  assert.ok(body.includes('=== null'), '梯次走完（null）必须有停手分支，不得继续排程');
});

test('用户手势三处都重置自愈梯次（封顶后的恢复路径）', async () => {
  const source = await readFile(sourcePath, 'utf8');
  for (const anchor of [
    'function resetHealLadder',
    'export async function setGlobalPushToTalkEnabled',
    'export function requestAccessibilityTrust',
    'export async function openInputMonitoringPane',
  ]) {
    assert.ok(source.includes(anchor), `缺少 ${anchor}（手势重置是否被删？）`);
  }
  const resetCalls = source.split('resetHealLadder()').length - 1;
  assert.ok(
    resetCalls >= 4,
    `resetHealLadder 定义 + 至少三处手势调用，实际出现 ${resetCalls} 次`,
  );
});

test('重建路径（stop→start）不复位梯次计数，退避才能逐档加深', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const stopBody = functionBody(
    source,
    'stopGlobalPushToTalk',
    '/** 设置页开关：写配置后热启停，不用重启。 */',
  );
  assert.ok(
    !stopBody.includes('healAttempt = 0'),
    'stopGlobalPushToTalk 不得复位 healAttempt（重建会经此路径，复位即退避失效）',
  );
  assert.ok(stopBody.includes('clearTimeout'), '看门狗定时器须用 clearTimeout 清理');
});
