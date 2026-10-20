// 036 spike · cua-driver 进程内运行时四项真机验证（对齐 pi-sdk-probe 规矩：
// 动正式代码前先证明关键行为）。全部走 @trycua/cua-driver 的 CuaDriver.create()
// ——不装独立二进制、不起 daemon，原生运行时就是平台包里的 .node。
//
// 用法：node scripts/spike-cua-driver.mjs
// 前置：TextEdit 会被自动拉起（osascript 建新文档）；终端需已授屏幕录制+辅助功能
// （权限弹窗按 TCC 归属到运行 node 的宿主终端）。
//
// 四项：
//  S1 进程内驱动启动 + listApps/listWindows 枚举（含 TextEdit 定位）
//  S2 getWindowState：窗口截图（落 /tmp）+ AX 树 + element_token 提取
//  S3 中文 type_text 后台落字（AX 直插路径，Hemi 核心诉求，官方无 CJK 承诺）
//  S4 scroll 后台行为 + refused 语义（ActionError/hint）与前台升级路径
// 结果：HEMI_CUA_SPIKE_RESULT JSON + 逐项 PASS/FAIL；exit 0 = 全过。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

import {
  CuaDriver,
  ActionTarget,
  ClickPosition,
  ClickInput,
  InputDeliveryMode,
  ScrollInput,
  ScrollDirection,
  ScrollBy,
  TypeTextInput,
  GetDesktopStateInput,
  GetWindowStateInput,
  ListAppsInput,
  ListWindowsInput,
} from '@trycua/cua-driver';

const results = [];
function record(id, ok, note) {
  results.push({ id, ok, note });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${note}`);
}
const brief = (v) => {
  try { return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x), 1); }
  catch { return String(v); }
};

// --- 准备：拉起 TextEdit 并新建文档（spike 的落字靶子）---
let textEditPid = null;
try {
  execFileSync('osascript', ['-e', 'tell application "TextEdit" to activate\n delay 0.5\n make new document']);
  await new Promise((r) => setTimeout(r, 800));
} catch (e) {
  console.log(`TextEdit 准备失败（不致命，S1 起来后重试定位）：${e.message}`);
}

let driver = null;
try {
  // S1 · 进程内驱动 + 窗口枚举
  const t0 = Date.now();
  driver = CuaDriver.create(undefined);
  const apps = await driver.listApps(ListAppsInput.create({}));
  const windows = await driver.listWindows(ListWindowsInput.create({ onScreenOnly: true }));
  const te = apps.apps.find((a) => a.name === 'TextEdit');
  const teWin = te ? windows.windows.find((w) => w.pid === te.pid) : undefined;
  record('S1-inproc-driver',
    apps.apps.length > 0 && windows.windows.length > 0,
    `create→listApps ${Date.now() - t0}ms；apps=${apps.apps.length} windows=${windows.windows.length}` +
      (te ? `；TextEdit pid=${te.pid}${teWin ? ` windowId=${teWin.windowId} title=「${teWin.title}」bounds=${brief(teWin.bounds)}` : ' 但无窗口'}` : '；未找到 TextEdit'));
  if (te && teWin) {
    textEditPid = te.pid;

    // S2 · getWindowState：截图 + AX 树 + element_token
    const t2 = Date.now();
    const ws = await driver.getWindowState(GetWindowStateInput.create({
      pid: te.pid,
      windowId: teWin.windowId,
      includeAccessibilityTree: true,
      includeScreenshot: true,
      maxImageDimension: 960,
      timeoutMs: 2000,
    }));
    const shot = ws.images?.[0];
    if (shot?.dataBase64) fs.writeFileSync('/tmp/hemi-cua-spike-window.png', Buffer.from(shot.dataBase64, 'base64'));
    const els = ws.elements ?? [];
    const tokens = els.filter((e) => e.elementToken);
    record('S2-window-state',
      Boolean(shot) && els.length > 0,
      `${Date.now() - t2}ms；elements=${els.length}（带 token ${tokens.length}）screenshot=${ws.screenshotWidth}×${ws.screenshotHeight}` +
        `${ws.truncated ? ' [truncated]' : ''}${ws.degraded ? ` [degraded:${ws.degradedReason}]` : ''}` +
        `；首元素=${els[0]?.role}「${els[0]?.label ?? ''}」` +
        `；PNG→/tmp/hemi-cua-spike-window.png`);

    // S3 · 中文后台键入（AX 直插；不点不动鼠标）
    const t3 = Date.now();
    const text = '你好世界，Hemi 电脑控制 spike ③ AX直插。';
    const typed = await driver.typeText(TypeTextInput.create({
      text,
      target: new ActionTarget.Window({ pid: te.pid, windowId: teWin.windowId }),
    }));
    // 验证落字：再拍一次窗口状态，值里应包含所键文本
    const after = await driver.getWindowState(GetWindowStateInput.create({
      pid: te.pid, windowId: teWin.windowId, includeAccessibilityTree: true, timeoutMs: 2000,
    }));
    const area = (after.elements ?? []).find((e) => (e.value ?? '').includes('你好世界'));
    record('S3-cjk-type',
      Boolean(area),
      `typeText ${Date.now() - t3}ms text=${typed.text?.slice(0, 90) ?? ''}；AX 复查${area ? '命中落字' : '未见文本'}`);

    // S4 · scroll 后台：原生 AppKit 预期可后台；记录 effect/route/escalation 语义
    const t4 = Date.now();
    let scrollNote = '';
    try {
      const sc = await driver.scroll(ScrollInput.create({
        x: 100, y: 100, direction: ScrollDirection.Down, by: ScrollBy.Line, amount: 3n,
        target: new ActionTarget.Window({ pid: te.pid, windowId: teWin.windowId }),
      }));
      const act = sc.action;
      scrollNote = `action=${brief(act)}；text=${sc.text?.slice(0, 120) ?? ''}`;
      record('S4-scroll-bg', sc.action ? act.effect !== 4 : true, `scroll ${Date.now() - t4}ms ${scrollNote}`);
    } catch (e) {
      // refused 抛 DriverError.Tool：这正是「后台不可用→前台升级」策略的输入
      record('S4-scroll-bg', true, `refused（异常通道）：${e.message?.slice(0, 200)}`);
    }

    // S5（附加）· 坐标后台点击 + click refused 时 ActionError 形态
    const t5 = Date.now();
    try {
      const ck = await driver.click(ClickInput.create({
        target: new ActionTarget.Window({ pid: te.pid, windowId: teWin.windowId }),
        position: new ClickPosition.Coordinates({ x: Math.floor((ws.screenshotWidth ?? 400) / 2), y: Math.floor((ws.screenshotHeight ?? 300) / 2) }),
        deliveryMode: InputDeliveryMode.Background,
      }));
      record('S5-click-bg', true, `click ${Date.now() - t5}ms effect=${ck.effect} route=${ck.route} delivery=${brief(ck.delivery)} escalation=${brief(ck.escalation)} summary=${ck.summary?.slice(0, 100) ?? ''}`);
    } catch (e) {
      record('S5-click-bg', false, `click 异常：${e.message?.slice(0, 200)}`);
    }
  } else {
    record('S2-window-state', false, 'TextEdit 窗口未定位到，跳过 S2–S5');
    record('S3-cjk-type', false, '跳过');
    record('S4-scroll-bg', false, '跳过');
    record('S5-click-bg', false, '跳过');
  }

  // S6（附加）· 桌面级截图（对话侧「看屏幕回答」链路）
  const t6 = Date.now();
  const desk = await driver.getDesktopState(GetDesktopStateInput.create({ maxImageDimension: 960 }));
  const dshot = desk.images?.[0];
  if (dshot?.dataBase64) fs.writeFileSync('/tmp/hemi-cua-spike-desktop.png', Buffer.from(dshot.dataBase64, 'base64'));
  record('S6-desktop-state', Boolean(dshot), `${Date.now() - t6}ms ${desk.text?.slice(0, 80) ?? ''}；PNG→/tmp/hemi-cua-spike-desktop.png`);
} catch (e) {
  record('spike-fatal', false, `${e?.constructor?.name ?? ''}: ${e?.message ?? e}`);
  if (e?.errorCode) console.log(`errorCode=${e.errorCode}`);
} finally {
  try { await driver?.shutdown(); } catch { /* 尽力而为 */ }
  try { driver?.uniffiDestroy?.(); } catch { /* 尽力而为 */ }
}

const okCount = results.filter((r) => r.ok).length;
console.log(`\nHEMI_CUA_SPIKE_RESULT ${JSON.stringify({ pass: okCount, total: results.length, results })}`);
process.exit(okCount === results.length ? 0 : 1);
