// 061 附件缩略图真机验证：隔离 userData 起真实应用（真实渲染层＋真实 IPC＋真实模型回合），
// 全链断言——粘贴登记（无视觉配置下不再拒收）→ 托盘缩略图 → 右栏预览大图 → 真实发送入档
// （气泡缩略图＋档案冻结 thumbnailUrl/stagedPath）→ 重启 → 历史气泡缩略图仍在、点开按暂存
// 路径受控回退读出大图。证据（截图/断言 JSON/electron 日志）落 HEMI_061_EVIDENCE，
// exit 0＝全过。
//
// 运行：node scripts/verify-061-attachments.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const electronBin = path.join('node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
const realUserData = path.join(os.homedir(), 'Library', 'Application Support', 'hemi');
const PORT = 9473;
/** 320×200 双色测试图（上青绿/中白线/下暖橙），登记后应被压成 ≤144px 缩略图。 */
const PASTE_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAUAAAADICAIAAAAWZq/8AAAEv0lEQVR4nO3T19UQVBBG0b8STJhQUC5mVMDQxK0EFQwjZsXc4m0Di3D5cHBPAfusefguLs1+YvaTs5+a/fTsZ2Zfnv3s7OdmPz/7hdkvzr4y+6XZL8++Ovva7Fdmvzr7+uw1+8bs12a/PvuN2W/Ofmv227PfmX1z9ruz35v9/uxbs2/PvjP7g9kfzv5o9sezdXV1/3334v/2sK7u49Q1YF3dcNeAdXXDXQPW1Q13DVhXN9w1YF3dcNeAdXXDXQPW1Q13DVhXN9w1YF3dcNeAdXXDXQPW1Q13DVhXN9w1YF3dcNeAdXXDXQPW1Q13DVhXN9w1YF3dcNeAdXXDXQPW1Q13DVhXN9w1YF3dcNeAdXXDXQPW1Q13DVhXN9w1YF3dcNeAdXXDXQPW1Q13DVhXN9w1YF3dcNeAdXXDXQPW1Q13DVhXN9w1YF3dcNeAdXXDXQPW1Q13DVhXN9w1YF3dcNeAdXXDXQPW1Q13DVhXN9w1YF3dcNeAdXXDXQPW1Q13DVhXN9w1YF3dcNeAdXXDXQPW1Q13DVhXN9w1YF3dcNeAdXXDXQPW1Q13DVhXN9w1YF3dcNeAdXXDXQPW1Q13DVhXN9w1YF3dcNeAdXXDXQPW1Q13DVhXN9w1YF3dcNeAdXXDXQPW1Q13DVhXN9w1YF3dcNeAdXXDXQPW1Q13DVhXN9w1YF3dcNeAdXXDXQPW1Q13DVhXN9w1YF3dcNeAdXXDXQPW1Q13DVhXN9w1YF3dcNeAdXXD3YtHzrnsGbBz4TNg58JnwM6Fz4CdC58BOxc+A3YufAbsXPgM2LnwGbBz4TNg58JnwM6Fz4CdC58BOxc+A3YufAbsXPgM2LnwGbBz4TNg58JnwM6F7+LcXeeTdT5d57N17q1zf53P1/linS/X+WqdWefrdR6s8806367z3Trfr/PDOj+u89M6P6/zyzoP1/l1nd/W+X2dP9b5c52/1vl7kcnk/1o2YDI5LBswmRyWDZhMDssGTCaHZQMmk8OyAZPJYdmAyeSwbMBkclg2YDI5LBswmRyWDZhMDssGTCaHZQMmk8OyAZPJYdmAyeSwbMBkclg2YDI5LBswmRyWDZhMDssGTCaHZQMmk8OyAZPJYdmAyeSwbMBkclg2YDI5LBswmRyWDZhMDssGTCaHZQMmk8OyAZPJYdmAyeSwbMBkclg2YDI5LBswmRyWDZhMDssGTCaHZQMmk8OyAZPJYdmAyeSwbMBkclg2YDI5LBswmRyWDZhMDssGTCaHZQMmk8OyAZPJYdmAyeSwbMBkclg2YDI5LBswmRyWDZhMDssGTCaHZQMmk8OyAZPJYdmAyeSwbMBkclg2YDI5LBswmRyWDZhMDssGTCaHZQMmk8OyAZPJYdmAyeSwbMBkclg2YDI5LBswmRyWDZhMDssGTCaHZQMmk8OyAZPJYdmAyeSwbMBkclg2YDI5LBswmRyWDZhMDssGTCaHZQMmk8OyAZPJYdmAyeSwbMBkclg2YDI5LBswmRyWDZhMDssGTCaHZQMmk8OyAZPJYdmAyeSwbMBkclg2YDI5LBswmRyWDZhMDssGTCaHZQMmk8OyAZPJYdmAyeSwbMBkclg2YDI5LBswmRyWDZhMDsv/AH6pTtOXbpinAAAAAElFTkSuQmCC';
const ASK = '收到这张图片附件了吗？一句话回答即可，不要调用工具。';
const evidenceDir = path.resolve(
  process.env.HEMI_061_EVIDENCE ?? path.join('.visual', 'workflow', 'vision', `061-real-${Date.now()}`),
);
fs.mkdirSync(evidenceDir, { recursive: true });

/** 递归清空视觉模型配置——验证 2026-10-18 撤门槛：无任何视觉能力也能粘贴登记。 */
function stripVision(node) {
  if (Array.isArray(node)) { node.forEach(stripVision); return; }
  if (node && typeof node === 'object') {
    for (const key of Object.keys(node)) {
      if (key === 'visionModel') node[key] = '';
      if (key === 'supportsVision') node[key] = false;
      stripVision(node[key]);
    }
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hemi061-attach-'));
const UD = path.join(root, 'userData');
fs.mkdirSync(path.join(UD, 'conversations'), { recursive: true });
for (const name of ['text-model.json', 'text-model-profiles.json', 'onboarding.json']) {
  const source = path.join(realUserData, name);
  if (!fs.existsSync(source)) throw new Error(`缺真实配置：${source}`);
  try {
    const config = JSON.parse(fs.readFileSync(source, 'utf8'));
    stripVision(config);
    fs.writeFileSync(path.join(UD, name), JSON.stringify(config));
  } catch {
    fs.copyFileSync(source, path.join(UD, name));
  }
}
// 钉 deepseek 档：真机首跑撞上 vvcode/claude 中转的 Cross-protocol 400（与 061
// 无关的上游协议问题），备用档 deepseek-flash 稳定可用——新会话模型也钉过去。
try {
  const profilesPath = path.join(UD, 'text-model-profiles.json');
  const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
  const keys = (profiles.providers ?? []).flatMap((provider) =>
    (provider.models ?? []).map((model) => `${provider.id}/${model.id}`),
  );
  const deepseek = keys.find((key) => key.includes('deepseek')) ?? profiles.defaultModelId ?? keys[0];
  profiles.defaultModelId = deepseek;
  profiles.lastConversationModelKey = deepseek;
  fs.writeFileSync(profilesPath, JSON.stringify(profiles));
  console.log(`[061] 会话模型钉死：${deepseek}`);
} catch (error) {
  console.warn(`[061] 模型钉死失败（沿用原配置）：${error.message}`);
}
console.log(`[061] 实例：${UD}\n[061] 证据：${evidenceDir}（视觉配置已清空）`);

const checks = {};
let child = null;
const shutdown = () => {
  if (child && child.pid) { try { child.kill('SIGKILL'); } catch { /* 已退 */ } }
};
process.on('exit', shutdown);
process.on('SIGINT', () => { shutdown(); process.exit(130); });

async function bootPhase(label) {
  const logFd = fs.openSync(path.join(evidenceDir, `electron-${label}.log`), 'w');
  child = spawn(electronBin, ['.', `--remote-debugging-port=${PORT}`], {
    env: { ...process.env, HEMI_USER_DATA_DIR: UD },
    stdio: ['ignore', logFd, logFd],
  });
  fs.closeSync(logFd);
  let targets = null;
  for (let i = 0; i < 120; i += 1) {
    targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).catch(() => null);
    if (targets?.some((t) => t.type === 'page' && !/mode=/.test(t.url))) break;
    await sleep(500);
  }
  const page = targets?.find((t) => t.type === 'page' && !/mode=/.test(t.url));
  if (!page) throw new Error(`${label}: 主窗口 60s 未就绪`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evalJs = async (expression, timeoutMs = 30_000) => {
    const result = await Promise.race([
      send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
      sleep(timeoutMs).then(() => null),
    ]).catch(() => null);
    if (result == null) return undefined;
    if (result?.exceptionDetails) {
      throw new Error(`page-eval: ${result.exceptionDetails.text ?? ''}`.slice(0, 200));
    }
    return result?.result?.value;
  };
  await send('Runtime.enable');
  for (let i = 0; i < 120; i += 1) {
    if (await evalJs('window.hemiVoice && Boolean(document.querySelector("textarea")) && !document.querySelector(".setup-shell")')) break;
    await sleep(500);
  }
  const shot = async (name) => {
    const frame = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(evidenceDir, `${name}.png`), Buffer.from(frame.data, 'base64'));
    console.log(`[061] 截图 ${name}.png`);
  };
  return { evalJs, send, shot, close: () => { try { ws.close(); } catch { /* 已关 */ } } };
}

const wait = async (label, predicate, timeout = 30_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await predicate();
    if (value) return value;
    await sleep(120);
  }
  throw new Error(`timeout: ${label}`);
};

const latestArchive = () => {
  const dir = path.join(UD, 'conversations');
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('._'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
};

// ---- 阶段一：粘贴 → 托盘缩略图 → 右栏预览 → 真实发送 → 入档冻结 ----
const phase1 = await bootPhase('phase1');
try {
  // 真实 paste 事件（React onPaste 走 clipboardData.items → attach-paste IPC → nativeImage 缩略图）。
  const pasted = await phase1.evalJs(`(() => {
    const ta = document.querySelector('textarea');
    if (!ta) return false;
    const binary = atob(${JSON.stringify(PASTE_PNG_B64)});
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }));
    ta.focus({ preventScroll: true });
    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
    return true;
  })()`);
  if (!pasted) throw new Error('textarea 不在');

  const trayThumb = await wait('托盘缩略图出现（无视觉配置下登记成功＝门槛撤除实证）', () =>
    phase1.evalJs(`(() => {
      const img = document.querySelector('.h24-attach-card-image .h24-attach-thumb');
      if (!img) return null;
      return { src: String(img.getAttribute('src') ?? '').slice(0, 40), w: img.naturalWidth, h: img.naturalHeight, rendered: img.complete && img.naturalWidth > 0 };
    })()`));
  checks['1-粘贴登记+托盘缩略图(视觉配置已清空)'] = true;
  checks['1a-缩略图已解码'] = Boolean(trayThumb.rendered);
  checks['1b-缩略图长边≤144'] = Math.max(trayThumb.w, trayThumb.h) <= 144 && Math.max(trayThumb.w, trayThumb.h) > 0;
  checks['1c-缩略图是dataUrl'] = trayThumb.src.startsWith('data:image/');
  console.log(`[061] 托盘缩略图：${JSON.stringify(trayThumb)}`);

  checks['1d-移除钮在场'] = Boolean(await phase1.evalJs(`Boolean(document.querySelector('.h24-attach-card-image .h24-attach-remove'))`));
  await phase1.shot('01-tray-thumbnail');

  // 点缩略图 → 右栏预览：大图 dataUrl 读取（修复的 attachment Tab 读取分支，登记表命中路径）。
  await phase1.evalJs(`document.querySelector('.h24-attach-card-image .h24-attach-open').click()`);
  const preview1 = await wait('右栏预览大图', () =>
    phase1.evalJs(`(() => {
      const img = document.querySelector('img.h24-preview-image');
      if (!img || !img.complete || !img.naturalWidth) return null;
      return { w: img.naturalWidth, h: img.naturalHeight, bytes: (img.getAttribute('src') ?? '').length };
    })()`));
  checks['2-右栏预览大图(修复回归·登记表读取)'] = true;
  checks['2a-预览原图尺寸=320x200'] = preview1.w === 320 && preview1.h === 200;
  console.log(`[061] 预览大图：${JSON.stringify(preview1)}`);
  await phase1.shot('02-preview-live');
  await phase1.evalJs(`(() => { [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? '').includes('关闭')) ?.click(); return true; })()`);

  // 真实发送（真实模型回合；无视觉能力 → 图片按说明块如实降级，回合应正常完成）。
  const sent = await phase1.evalJs(`(() => {
    const ta = document.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(ASK)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const btn = [...document.querySelectorAll('.text-composer-send')].find((e) => e.offsetParent !== null);
    if (btn && !btn.classList.contains('is-stop')) { btn.click(); return 'clicked'; }
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return 'enter';
  })()`);
  console.log(`[061] 发送方式：${sent}`);

  // 回合收口按档案判定：hemi 轮（成功回复或 error 留痕）落盘即算回合结束。
  const settled = await wait('回合收口（hemi 轮落档）', () => {
    const archive = latestArchive();
    if (!archive) return null;
    const hemi = (archive.turns ?? []).find((t) => t.author === 'hemi');
    return hemi ? { kind: hemi.kind ?? 'reply', text: String(hemi.text ?? '').slice(0, 60) } : null;
  }, 180_000);
  checks['3-回合完成(无视觉能力·图片降级不吞回合)'] = settled.kind !== 'error';
  console.log(`[061] 回合收口：${JSON.stringify(settled)}`);

  // 气泡缩略图（发送后 frozen view 带 thumbnailUrl）。
  await wait('气泡缩略图出现', () =>
    phase1.evalJs(`(() => { const img = document.querySelector('.h24-msg-attachment-image .h24-attach-thumb'); return img && img.complete && img.naturalWidth > 0 ? true : null; })()`));
  checks['4-气泡缩略图'] = true;
  await phase1.shot('03-bubble-thumbnail');

  // 档案冻结：thumbnailUrl + stagedPath 落 conversations 档案；暂存字节在盘。
  const archive = await wait('档案冻结附件视图', () => {
    const record = latestArchive();
    const userTurn = record ? [...(record.turns ?? [])].reverse().find((t) => t.author === 'user') : null;
    return userTurn?.attachments?.[0]?.thumbnailUrl ? { record, view: userTurn.attachments[0] } : null;
  }, 15_000);
  const view = archive.view;
  checks['5-档案冻结thumbnailUrl'] = Boolean(view.thumbnailUrl?.startsWith('data:image/'));
  checks['5a-档案冻结stagedPath'] = typeof view.stagedPath === 'string' && view.stagedPath.length > 0;
  checks['5b-暂存字节在盘'] = checks['5a-档案冻结stagedPath'] && fs.existsSync(view.stagedPath) && fs.statSync(view.stagedPath).size > 0;
  console.log(`[061] 档案：cid=${archive.record.id} thumbnail=${view.thumbnailUrl.slice(0, 30)}… staged=${view.stagedPath}（${fs.statSync(view.stagedPath).size}B）`);

  fs.copyFileSync(view.stagedPath, path.join(evidenceDir, 'staged-paste.png'));
} finally {
  shutdown();
  await sleep(1_500);
  phase1.close();
}

// ---- 阶段二：重启 → 历史气泡缩略图仍在 → 点开按暂存路径受控回退读大图 ----
const phase2 = await bootPhase('phase2');
try {
  const bubbleReady = async () =>
    phase2.evalJs(`(() => { const img = document.querySelector('.h24-msg-attachment-image .h24-attach-thumb'); return img && img.complete && img.naturalWidth > 0 ? true : null; })()`);
  let restored = false;
  for (let i = 0; i < 16 && !restored; i += 1) { restored = Boolean(await bubbleReady()); if (!restored) await sleep(500); }
  if (!restored) {
    // 启动没有自动回到该会话：点「最近会话」第一行。
    await phase2.evalJs(`(() => { const row = document.querySelector('.h24-sidebar-nav .h24-sidebar-open'); if (row) { row.click(); return row.textContent.trim().slice(0, 24); } return null; })()`);
    await wait('重启后气泡缩略图（档案 thumbnailUrl）', bubbleReady, 20_000);
  }
  checks['6-重启后气泡缩略图(档案冻结)'] = true;
  await phase2.shot('04-restart-bubble');

  // 登记表已空 → readAttachmentPreview 带 stagedPath 走暂存区受控回退。
  await phase2.evalJs(`document.querySelector('.h24-msg-attachment-image').click()`);
  const preview2 = await wait('重启后预览大图（暂存回退）', () =>
    phase2.evalJs(`(() => {
      const img = document.querySelector('img.h24-preview-image');
      if (!img || !img.complete || !img.naturalWidth) return null;
      const loading = document.body.innerText.includes('正在读取');
      return { w: img.naturalWidth, h: img.naturalHeight, loading };
    })()`));
  checks['7-重启后预览大图(stagedPath受控回退)'] = !preview2.loading && preview2.w === 320 && preview2.h === 200;
  console.log(`[061] 重启预览：${JSON.stringify(preview2)}`);
  await phase2.shot('05-restart-preview');
} finally {
  shutdown();
  await sleep(1_500);
  phase2.close();
}

fs.writeFileSync(path.join(evidenceDir, 'checks.json'), JSON.stringify({ checks, userData: UD }, null, 2));
const failed = Object.entries(checks).filter(([, ok]) => !ok);
console.log(`HEMI_061_RESULT=${JSON.stringify({ checks, failed: failed.map(([k]) => k) })}`);
if (failed.length) {
  console.error(`[061] 未过项：${failed.map(([k]) => k).join(' | ')}`);
  process.exit(1);
}
console.log('[061] 全部断言通过');
process.exit(0);
