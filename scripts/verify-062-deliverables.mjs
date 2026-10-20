// 062 会话交付物真机验证：隔离 userData 起真实应用（真实渲染层＋真实 IPC＋真实模型回合），
// 全链断言——主 agent 生成 SVG → register_delivery 宿主查证登记（flow.artifacts 带
// realpath/身份/producers）→ 对话流紧凑入口 → 右侧预览读出本次内容 → ＋ 菜单 →
// 第二回合更新同一文件（contentVersion 递增、入口不重复、预览原位刷新）＋ 交付
// 范围外格式（zip 文件信息态）＋ 正文 Markdown 本地链接经宿主解析进右侧 →
// 重启后 flow 恢复、＋ 菜单可再开同一文件。证据（截图/断言 JSON/electron 日志）落
// HEMI_062_EVIDENCE，exit 0＝全过。
//
// 运行：node scripts/verify-062-deliverables.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const electronBin = path.join('node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
const realUserData = path.join(os.homedir(), 'Library', 'Application Support', 'hemi');
const PORT = 9474;
const MARK = `m${Date.now().toString(36).slice(-6)}`;
const SVG_NAME = `hemi062-a-${MARK}.svg`;
const ZIP_NAME = `hemi062-b-${MARK}.zip`;
const evidenceDir = path.resolve(
  process.env.HEMI_062_EVIDENCE ?? path.join('.visual', 'workflow', 'vision', `062-real-${Date.now()}`),
);
fs.mkdirSync(evidenceDir, { recursive: true });

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hemi062-deliv-'));
const UD = path.join(root, 'userData');
fs.mkdirSync(path.join(UD, 'conversations'), { recursive: true });
for (const name of ['text-model.json', 'text-model-profiles.json', 'onboarding.json']) {
  const source = path.join(realUserData, name);
  if (!fs.existsSync(source)) throw new Error(`缺真实配置：${source}`);
  fs.copyFileSync(source, path.join(UD, name));
}
// 钉 deepseek 档：与 061 同口径（vvcode/claude 中转 Cross-protocol 400 的上游问题与此无关）。
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
  console.log(`[062] 会话模型钉死：${deepseek}`);
} catch (error) {
  console.warn(`[062] 模型钉死失败（沿用原配置）：${error.message}`);
}
console.log(`[062] 标记：${MARK}\n[062] 实例：${UD}\n[062] 证据：${evidenceDir}`);

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
    console.log(`[062] 截图 ${name}.png`);
  };
  return { evalJs, send, shot, close: () => { try { ws.close(); } catch { /* 已关 */ } } };
}

const wait = async (label, predicate, timeout = 30_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await predicate();
    if (value) return value;
    await sleep(150);
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

/** 会话 flow 里的交付物（按最新档案读 flow.artifacts）。 */
const flowDeliverables = () => {
  const record = latestArchive();
  const artifacts = record?.flow?.artifacts;
  return artifacts && typeof artifacts === 'object' ? artifacts : null;
};

const sendUserText = async (phase, text) => {
  const how = await phase.evalJs(`(() => {
    const ta = document.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(text)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const btn = [...document.querySelectorAll('.text-composer-send')].find((e) => e.offsetParent !== null);
    if (btn && !btn.classList.contains('is-stop')) { btn.click(); return 'clicked'; }
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return 'enter';
  })()`);
  console.log(`[062] 发送（${how}）：${text.slice(0, 40)}…`);
};

const previewImageState = (phase) => phase.evalJs(`(() => {
  const img = document.querySelector('img.h24-preview-image');
  if (!img) return null;
  return { src: String(img.src ?? '').slice(0, 60), w: img.naturalWidth, h: img.naturalHeight, rendered: img.complete && img.naturalWidth > 0, full: String(img.src ?? '') };
})()`);

const decodeDataUrlText = (dataUrl) => {
  const base64 = String(dataUrl).split(',')[1] ?? '';
  return Buffer.from(base64, 'base64').toString('utf8');
};

// ---- 阶段一：主 agent SVG 交付 → 查证登记 → 入口 → 右侧 → 更新/新文件/链接 ----
const phase1 = await bootPhase('phase1');
try {
  await sendUserText(phase1,
    `在桌面（~/Desktop）创建文件 ${SVG_NAME}：一张 240x120 的 SVG，蓝色矩形，里面写文字 062A${MARK}。` +
    `创建完成后用 register_delivery 工具把这个文件声明为正式交付（path 用 ~/Desktop/${SVG_NAME}）。`);
  const svgArtifact = await wait('flow 登记交付（宿主查证）', () => {
    const artifacts = flowDeliverables();
    if (!artifacts) return null;
    return Object.values(artifacts).find((a) => a?.name === SVG_NAME) ?? null;
  }, 240_000);
  checks['1-主agent声明→宿主查证登记'] = true;
  checks['1a-登记路径是真实绝对路径'] = String(svgArtifact.path).startsWith('/') && String(svgArtifact.path).includes(SVG_NAME);
  checks['1b-登记带身份与归属'] = typeof svgArtifact.artifactId === 'string'
    && typeof svgArtifact.producerRunId === 'string'
    && Array.isArray(svgArtifact.producers) && svgArtifact.producers.length >= 1;
  checks['1c-真实文件在盘'] = fs.existsSync(svgArtifact.path) && fs.statSync(svgArtifact.path).size > 0;
  console.log(`[062] 登记：${JSON.stringify({ artifactId: svgArtifact.artifactId, path: svgArtifact.path, v: svgArtifact.contentVersion })}`);

  // 等回合自然收口（登记是回合内工具，正文随后；idle 后 chip 稳定）。
  await wait('回合收口（flow idle）', () => flowDeliverables() && latestArchive()?.flow?.phase === 'idle', 240_000).catch(() => null);

  // 对话流紧凑入口。
  const chip = await wait('对话入口 chip', () =>
    phase1.evalJs(`(() => {
      const chip = document.querySelector('.h62-deliverable-chip');
      return chip ? { text: chip.textContent.trim(), title: chip.title } : null;
    })()`));
  checks['2-对话流紧凑入口'] = chip.text.includes(SVG_NAME);
  console.log(`[062] 入口 chip：${JSON.stringify(chip)}`);
  await phase1.shot('01-entry-chip');

  // 点击入口 → 右侧预览（SVG 解码 + dataUrl 内容含本次标记）。
  await phase1.evalJs(`document.querySelector('.h62-deliverable-chip').click()`);
  const image1 = await wait('右侧预览图片', () =>
    phase1.evalJs(`(() => {
      const img = document.querySelector('img.h24-preview-image');
      if (!img || !img.complete || !img.naturalWidth) return null;
      return { src: String(img.getAttribute('src') ?? '').slice(0, 60), w: img.naturalWidth, h: img.naturalHeight, full: String(img.getAttribute('src') ?? '') };
    })()`));
  const svgText1 = decodeDataUrlText(image1.full);
  checks['3-右侧预览读取本次产物'] = image1.w > 0 && svgText1.includes(`062A${MARK}`);
  console.log(`[062] 预览：${image1.w}x${image1.h}，内容含标记=${svgText1.includes(`062A${MARK}`)}`);
  await phase1.shot('02-preview-svg');

  // ＋ 菜单列出当前会话交付物。
  await phase1.evalJs(`document.querySelector('.h24-preview-add')?.click()`);
  const menu = await wait('＋ 菜单交付物项', () =>
    phase1.evalJs(`(() => {
      const items = [...document.querySelectorAll('.h24-preview-add-item')].map((b) => b.textContent.trim());
      return items.length ? items : null;
    })()`));
  checks['4-＋菜单列出交付物'] = menu.some((item) => item.includes(SVG_NAME));
  console.log(`[062] ＋ 菜单：${JSON.stringify(menu)}`);
  await phase1.evalJs(`document.querySelector('.h24-preview-add')?.click()`); // 收起菜单

  // ---- 第二回合：更新同一 SVG ＋ 交付 zip ＋ 正文本地链接 ----
  await sendUserText(phase1,
    `做三件事：1) 把 ${SVG_NAME} 里的矩形改成红色、文字改成 062B${MARK} 后保存；` +
    `2) 在桌面再创建 ${ZIP_NAME}，内容随便写几个字节；` +
    `3) 用 register_delivery 把这两个文件都声明为正式交付。` +
    `全部做完后，在回复正文的最后一行原样写这个 Markdown 链接：[点开看](~/Desktop/${SVG_NAME})——一个字都不要改。`);
  const updated = await wait('更新登记（contentVersion 递增）＋ 新文件', () => {
    const artifacts = flowDeliverables();
    if (!artifacts) return null;
    const svg = Object.values(artifacts).find((a) => a?.name === SVG_NAME);
    const zip = Object.values(artifacts).find((a) => a?.name === ZIP_NAME);
    if (!svg || svg.contentVersion < 2 || !zip) return null;
    return { svg, zip };
  }, 240_000);
  checks['5-同文件更新身份复用'] = updated.svg.artifactId === svgArtifact.artifactId && updated.svg.contentVersion === 2;
  checks['5a-第二交付物登记'] = Boolean(updated.zip.artifactId) && updated.zip.artifactId !== updated.svg.artifactId;
  console.log(`[062] 更新：svg v${updated.svg.contentVersion}；zip=${updated.zip.artifactId}`);
  await wait('第二回合收口（flow idle）', () => latestArchive()?.flow?.phase === 'idle', 240_000).catch(() => null);

  // 入口不重复（同文件去重）：chip 总数 = svg 1 个 + zip 1 个。
  const chipCount = await wait('入口去重（svg 只一个 chip）', async () => {
    const value = await phase1.evalJs(`(() => {
      const chips = [...document.querySelectorAll('.h62-deliverable-chip')].map((c) => c.textContent.trim());
      return { total: chips.length, svg: chips.filter((t) => t.includes(${JSON.stringify(SVG_NAME)})).length, zip: chips.filter((t) => t.includes(${JSON.stringify(ZIP_NAME)})).length };
    })()`);
    return value && value.svg === 1 && value.zip === 1 ? value : null;
  });
  checks['6-入口去重(主/更新不重复出卡)'] = chipCount.svg === 1;
  await phase1.shot('03-two-chips');

  // 右侧正开 svg：内容更新原位刷新（不切走、不留旧缓存）。
  await phase1.evalJs(`(() => { const chip = [...document.querySelectorAll('.h62-deliverable-chip')].find((c) => c.textContent.includes(${JSON.stringify(SVG_NAME)})); if (chip) chip.click(); return true; })()`);
  const image2 = await wait('预览原位刷新到新内容', async () => {
    const value = await previewImageState(phase1);
    if (!value) return null;
    const text = decodeDataUrlText(value.full ?? '');
    return text.includes(`062B${MARK}`) ? value : null;
  });
  checks['7-更新后预览原位刷新'] = true;
  console.log(`[062] 刷新后预览含 062B${MARK}`);
  await phase1.shot('04-preview-updated');

  // zip（范围外格式）：文件信息态 + 系统打开入口。
  await phase1.evalJs(`(() => { [...document.querySelectorAll('.h62-deliverable-chip')].find((c) => c.textContent.includes(${JSON.stringify(ZIP_NAME)}))?.click(); return true; })()`);
  const unsupported = await wait('范围外格式文件信息态', () =>
    phase1.evalJs(`(() => {
      const box = document.querySelector('.h62-unsupported');
      if (!box) return null;
      return { name: box.querySelector('.h62-unsupported-name')?.textContent ?? '', hasOpen: [...box.querySelectorAll('button')].some((b) => b.textContent.includes('系统应用打开')) };
    })()`));
  checks['8-范围外格式文件信息态+系统打开'] = unsupported.name.includes(ZIP_NAME) && unsupported.hasOpen;
  await phase1.shot('05-unsupported-zip');

  // 正文 Markdown 本地链接 → 宿主解析进右侧。
  const linkClicked = await phase1.evalJs(`(() => {
    const link = [...document.querySelectorAll('.md a.h62-local-link')].find((a) => (a.textContent ?? '').includes('点开看'));
    if (!link) return null;
    link.click();
    return { href: String(link.getAttribute('href') ?? ''), text: link.textContent.trim() };
  })()`);
  if (!linkClicked) {
    checks['9-正文本地链接(模型未按稿给链接)'] = false;
    console.warn('[062] 模型没有按稿在正文放链接');
  } else {
    const image3 = await wait('链接点击→右侧读同一文件', async () => {
      const value = await previewImageState(phase1);
      if (!value) return null;
      const text = decodeDataUrlText(value.full ?? '');
      return text.includes(`062B${MARK}`) ? value : null;
    });
    checks['9-正文本地链接→右侧'] = true;
    console.log(`[062] 链接：${JSON.stringify(linkClicked)}`);
    await phase1.shot('06-local-link');
  }
} finally {
  shutdown();
  await sleep(1_500);
  phase1.close();
}

// ---- 阶段二：重启 → flow 恢复 → ＋ 菜单重开同一文件 ----
const phase2 = await bootPhase('phase2');
try {
  // 回到会话（若启动未自动选中）。
  await wait('会话恢复（交付物投影在场）', async () => {
    const restored = await phase2.evalJs(`(() => {
      const chips = [...document.querySelectorAll('.h62-deliverable-chip')].map((c) => c.textContent.trim());
      return chips.length ? chips : null;
    })()`);
    if (restored) return restored;
    await phase2.evalJs(`(() => { const row = document.querySelector('.h24-sidebar-nav .h24-sidebar-open'); if (row) row.click(); return true; })()`);
    return null;
  }, 30_000);
  checks['10-重启后入口恢复'] = true;
  await phase2.shot('07-restart-chips');

  // 重启后从 ＋ 菜单重开同一文件（不重跑任务、直接读出）。＋ 在预览面板里——
  // 先点对话入口把面板打开（Tab 队列随重启清空，属 027「不自动恢复 Tab」口径）。
  await wait('重启后点入口打开面板', async () => {
    const opened = await phase2.evalJs(`(() => {
      const chip = [...document.querySelectorAll('.h62-deliverable-chip')].find((c) => c.textContent.includes(${JSON.stringify(SVG_NAME)}));
      if (!chip) return 'no-chip';
      chip.click();
      return 'clicked';
    })()`);
    if (opened !== 'clicked') return null;
    return await phase2.evalJs(`Boolean(document.querySelector('.h24-preview'))`);
  }, 20_000);
  await phase2.evalJs(`(() => { const add = document.querySelector('.h24-preview-add'); if (add) { add.click(); return true; } return false; })()`);
  const menu2 = await wait('重启后 ＋ 菜单交付物', () =>
    phase2.evalJs(`(() => {
      const items = [...document.querySelectorAll('.h24-preview-add-item')].map((b) => b.textContent.trim());
      return items.length ? items : null;
    })()`));
  checks['11-重启后＋菜单列出交付物'] = menu2.some((item) => item.includes(SVG_NAME));
  await phase2.evalJs(`(() => {
    const item = [...document.querySelectorAll('.h24-preview-add-item')].find((b) => b.textContent.includes(${JSON.stringify(SVG_NAME)}));
    if (item) item.click();
    return Boolean(item);
  })()`);
  const image4 = await wait('重启后重开同一文件', async () => {
    const value = await previewImageState(phase2);
    if (!value) return null;
    const text = decodeDataUrlText(value.full ?? '');
    return text.includes(`062B${MARK}`) ? value : null;
  });
  checks['12-重启后重开读取成功(不重跑)'] = image4.w > 0;
  await phase2.shot('08-restart-preview');
} finally {
  shutdown();
  await sleep(1_500);
  phase2.close();
}

fs.writeFileSync(path.join(evidenceDir, 'checks.json'), JSON.stringify({ checks, mark: MARK, userData: UD }, null, 2));
const failed = Object.entries(checks).filter(([, ok]) => !ok);
console.log(`HEMI_062_RESULT=${JSON.stringify({ checks, failed: failed.map(([k]) => k) })}`);
if (failed.length) {
  console.error(`[062] 未过项：${failed.map(([k]) => k).join(' | ')}`);
  process.exit(1);
}
console.log('[062] 全部断言通过');
process.exit(0);
