// 063 真机验证（生产构建入口）：slash 面板（命令+技能分组、Esc 保草稿、/model
// 二层与本地切模）、技能行内标签（选择→发送→正式消息回显→档案落盘→执行指令
// 注入）、@ 四类引用候选（工作流版本/文件/对话）、加号菜单去截图、重载后草稿
// 标签恢复。隔离 userData + 真实模型两轮短回合；exit 0＝全过。
//
// 运行：node scripts/verify-063-composer.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const electronBin = path.join('node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
const realUserData = path.join(os.homedir(), 'Library', 'Application Support', 'hemi');
const PORT = 9478;
const MARK = `c${Date.now().toString(36).slice(-6)}`;
const SKILL_NAME = 'hemi063-probe';
const evidenceDir = path.resolve(
  process.env.HEMI_063_EVIDENCE ?? path.join('.visual', 'workflow', 'vision', `063-${Date.now()}`),
);
fs.mkdirSync(evidenceDir, { recursive: true });

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hemi063-'));
const UD = path.join(root, 'userData');
fs.mkdirSync(path.join(UD, 'conversations'), { recursive: true });
for (const name of ['text-model.json', 'text-model-profiles.json', 'onboarding.json']) {
  const source = path.join(realUserData, name);
  if (!fs.existsSync(source)) throw new Error(`缺真实配置：${source}`);
  fs.copyFileSync(source, path.join(UD, name));
}

// 项目工作区：带项目技能（唯一标记）、两个文件与一个子目录（@ 文件/文件夹候选）。
const projectDir = path.join(root, 'project');
fs.mkdirSync(path.join(projectDir, '.claude', 'skills', SKILL_NAME), { recursive: true });
fs.mkdirSync(path.join(projectDir, 'docs'), { recursive: true });
fs.writeFileSync(
  path.join(projectDir, '.claude', 'skills', SKILL_NAME, 'SKILL.md'),
  `---\nname: ${SKILL_NAME}\ndescription: 063 验证探针技能——被显式选择时回答里必须包含 063PROBE${MARK}\n---\n\n被调用时，在回答中包含标记 063PROBE${MARK}，并说明你按本技能执行。\n`,
);
fs.writeFileSync(path.join(projectDir, 'notes-063.md'), `# 063 笔记\n内容标记 063NOTE${MARK}\n`);
fs.writeFileSync(path.join(projectDir, 'docs', 'plan.md'), '# 计划\n063 引用验证\n');
fs.writeFileSync(path.join(UD, 'workspaces.json'), JSON.stringify({
  version: 1,
  projects: [{ id: 'ws-063', name: '063验证项目', dir: projectDir, createdAt: Date.now(), lastUsedAt: Date.now() }],
}, null, 2));

// 种子会话（绑定同一工作区；当前会话＝种子 A，@ 对话候选来自种子 B）。
const seed = (id, title, extra = {}) => JSON.stringify({
  id, title, createdAt: Date.now() - 60_000, updatedAt: Date.now() - 60_000,
  workspaceId: 'ws-063', profileId: null, turns: [
    { id: `${id}-u1`, text: '帮我记一下 063', createdAt: Date.now() - 60_000, author: 'user', inputSource: 'text' },
    { id: `${id}-h1`, text: '好的，已记录。', createdAt: Date.now() - 50_000, author: 'hemi' },
  ], ...extra,
}, null, 2);
fs.writeFileSync(path.join(UD, 'conversations', `conv-seed-a-${MARK}.json`), seed(`conv-seed-a-${MARK}`, '种子对话A'));
fs.writeFileSync(path.join(UD, 'conversations', `conv-seed-b-${MARK}.json`), seed(`conv-seed-b-${MARK}`, `063对话B${MARK}`));

console.log(`[063] 标记：${MARK}\n[063] 实例：${UD}\n[063] 工作区：${projectDir}\n[063] 证据：${evidenceDir}`);

const checks = {};
let electronChild = null;
let viteChild = null;
const shutdown = () => {
  for (const child of [electronChild, viteChild]) {
    if (child?.pid) { try { child.kill('SIGKILL'); } catch { /* 已退 */ } }
  }
};
process.on('exit', shutdown);
process.on('SIGINT', () => { shutdown(); process.exit(130); });

// 0) 可选 dev 入口（HEMI_063_DEV=1）：Vite dev server + StrictMode 双挂载口径
//    （AGENTS「两种入口」——构建产物通过不覆盖开发模式的双调用故障）。
const DEV_MODE = process.env.HEMI_063_DEV === '1';
const VITE_PORT = Number(process.env.HEMI_DEV_PORT_VERIFY || 5179);
let viteLogFd = null;
if (DEV_MODE) {
  viteLogFd = fs.openSync(path.join(evidenceDir, 'vite.log'), 'w');
  viteChild = spawn(process.execPath, ['scripts/dev-renderer.mjs'], {
    env: { ...process.env, HEMI_DEV_PORT: String(VITE_PORT) },
    stdio: ['ignore', viteLogFd, viteLogFd],
  });
  let viteUp = false;
  for (let i = 0; i < 60; i += 1) {
    viteUp = await fetch(`http://127.0.0.1:${VITE_PORT}/`).then((r) => r.ok).catch(() => false);
    if (viteUp) break;
    await sleep(500);
  }
  if (!viteUp) throw new Error('vite dev server 30s 未就绪');
  console.log(`[063] vite dev server 就绪：127.0.0.1:${VITE_PORT}`);
}

// 1) 起真实应用（缺省生产构建渲染层；HEMI_USER_DATA_DIR 隔离）。
const electronLog = fs.openSync(path.join(evidenceDir, 'electron.log'), 'w');
electronChild = spawn(electronBin, ['.', `--remote-debugging-port=${PORT}`], {
  env: {
    ...process.env,
    HEMI_USER_DATA_DIR: UD,
    ...(DEV_MODE ? { VITE_DEV_SERVER_URL: `http://127.0.0.1:${VITE_PORT}` } : {}),
  },
  stdio: ['ignore', electronLog, electronLog],
});
fs.closeSync(electronLog);

let targets = null;
for (let i = 0; i < 120; i += 1) {
  targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).catch(() => null);
  if (targets?.some((t) => t.type === 'page' && !/mode=/.test(t.url))) break;
  await sleep(500);
}
const page = targets?.find((t) => t.type === 'page' && !/mode=/.test(t.url));
if (!page) throw new Error('主窗口 60s 未就绪');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let seq = 0;
const pending = new Map();
const consoleErrors = [];
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    consoleErrors.push(message.params.args?.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200));
  }
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
  if (result?.exceptionDetails) throw new Error(`page-eval: ${result.exceptionDetails.text ?? ''}`.slice(0, 300));
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
  console.log(`[063] 截图 ${name}.png`);
};
const wait = async (label, predicate, timeout = 30_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await predicate();
    if (value) return value;
    await sleep(150);
  }
  throw new Error(`timeout: ${label}`);
};
/** 写入草稿（原生 setter 触发 React onChange；select 事件同步光标态）。 */
const setDraft = (text) => evalJs(`(() => {
  const ta = document.querySelector('textarea.text-composer-input');
  ta.focus();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, ${JSON.stringify(text)});
  ta.setSelectionRange(${text.length}, ${text.length});
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.dispatchEvent(new Event('select', { bubbles: true }));
  return true;
})()`);
const pressKey = (key, extra = '') => evalJs(`(() => {
  const ta = document.querySelector('textarea.text-composer-input');
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true ${extra} }));
  return true;
})()`);
const panelVisible = () => evalJs(`(() => {
  const slash = document.querySelector('.h24-command-menu');
  const at = document.querySelector('.h24-mention-menu');
  return slash ? 'slash' : at ? 'mention' : null;
})()`);
const clickPanelItem = (label) => evalJs(`(() => {
  const item = [...document.querySelectorAll('.h24-command-menu .h24-model-item, .h24-mention-menu .h24-model-item')]
    .find((el) => el.textContent.includes(${JSON.stringify(label)}));
  if (!item) return null;
  item.click();
  return 'clicked';
})()`);
const transcriptCount = () => evalJs(`document.querySelectorAll('.h24-user-message, article.h24-user-message').length`);
const currentConversationId = () => evalJs(`(async () => {
  const list = await window.hemiVoice.listConversations();
  return list?.sessions?.[0]?.id ?? null;
})()`);
const latestArchive = () => {
  const dir = path.join(UD, 'conversations');
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('._'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
};
const logText = () => fs.readFileSync(path.join(UD, 'hemi.log'), 'utf8');

const WORKFLOW_GRAPH = {
  nodes: [
    { id: 'in', type: 'hemi-input', meta: { position: { x: 0, y: 0 } }, data: { parameters: [{ key: 'topic', type: 'string', required: true }] } },
    { id: 'agent', type: 'hemi-agent', meta: { position: { x: 1, y: 0 } }, data: { title: '起草', goal: '按主题起草', outputSchema: { type: 'object', properties: { result: { type: 'string' } } } } },
    { id: 'deliver', type: 'hemi-deliver', meta: { position: { x: 2, y: 0 } }, data: { title: '交付', summary: '交付说明' } },
  ],
  edges: [
    { sourceNodeID: 'in', targetNodeID: 'agent' },
    { sourceNodeID: 'agent', targetNodeID: 'deliver' },
  ],
};

try {
  // 入口判定：dev 模式的证据属于开发入口（StrictMode 生效），否则为构建产物。
  const locationHref = await evalJs('location.href');
  checks['0-renderer入口'] = DEV_MODE ? String(locationHref).includes(`127.0.0.1:${VITE_PORT}`) : !String(locationHref).includes('127.0.0.1:517');
  console.log(`[063] renderer URL：${locationHref}`);

  // 会话落在种子 A/B 之一（绑定 ws-063）→ @ 文件/对话候选按项目工作区解析；
  // 两个种子时间戳相同，列表顺序不稳定，当前会话取其一、对话候选来自另一个。
  const opened = await wait('载入绑定工作区的会话', async () => {
    const id = await currentConversationId();
    return id === `conv-seed-a-${MARK}` || id === `conv-seed-b-${MARK}` ? id : null;
  });
  checks['1-载入绑定工作区的会话'] = Boolean(opened);
  console.log(`[063] 当前会话：${opened}`);

  // 发布一条工作流定义（@ 工作流候选按已发布版本展示）。
  const published = await evalJs(`(async () => {
    await window.hemiVoice.workflowSaveDraft('wf-063-${MARK}', ${JSON.stringify(WORKFLOW_GRAPH)}, '063验证流程');
    const result = await window.hemiVoice.workflowPublish('wf-063-${MARK}', 1, null);
    return result?.revision ?? null;
  })()`);
  checks['2-发布工作流定义'] = published === 1;
  console.log(`[063] 工作流发布 revision=${published}`);

  // —— slash 首层：命令+技能分组，不平铺模型 ——
  await setDraft('/');
  await wait('slash 面板打开', async () => (await panelVisible()) === 'slash');
  await wait('技能候选出现', () => evalJs(`Boolean([...document.querySelectorAll('.h24-command-menu .h24-model-item')].find((el) => el.textContent.includes('${SKILL_NAME}')))`));
  const hasModelFlat = await evalJs(`[...document.querySelectorAll('.h24-command-menu .h24-model-item')].filter((el) => el.textContent.includes('/') && !el.textContent.includes('/model')).length`);
  checks['3-首层分组命令+技能，不平铺模型'] = Number(hasModelFlat) === 0
    && Boolean(await evalJs(`Boolean([...document.querySelectorAll('.h24-command-menu .h24-model-item')].find((el) => el.textContent.includes('/model')))`) );
  await shot('slash-first-level');
  await pressKey('Escape');
  await wait('Esc 关面板', async () => (await panelVisible()) == null);
  const preserved = await evalJs(`document.querySelector('textarea.text-composer-input').value`);
  checks['4-Esc保草稿'] = preserved === '/';
  // 同一 token 不立刻重弹：点一下输入框（selection 不变）不重开——直接断言面板仍关。
  checks['5-同token不重弹'] = (await panelVisible()) == null;

  // —— /model 二层与本地切模 ——
  await setDraft('/model');
  await wait('面板随 /model 打开', async () => (await panelVisible()) === 'slash');
  await pressKey('Enter');
  await wait('模型二层打开', () => evalJs(`Boolean(document.querySelector('.h63-panel-search'))`));
  await shot('model-second-level');
  const beforeSwitch = await transcriptCount();
  const chipBefore = await evalJs(`document.querySelector('.h24-model-chip-label')?.textContent ?? ''`);
  const switched = await clickPanelItem('自动路由') ?? await evalJs(`(() => {
    const items = [...document.querySelectorAll('.h24-command-menu .h24-model-item')].filter((el) => !el.disabled);
    items[items.length - 1]?.click();
    return 'clicked';
  })()`);
  await wait('切模反馈出现', () => evalJs(`Boolean([...document.querySelectorAll('.text-composer-model-notice')].length)`));
  const afterSwitch = await transcriptCount();
  const tokenConsumed = await evalJs(`document.querySelector('textarea.text-composer-input').value`);
  checks['6-本地切模不伪造消息'] = switched === 'clicked' && Number(afterSwitch) === Number(beforeSwitch)
    && tokenConsumed === '';
  console.log(`[063] 切模反馈出现（chip ${chipBefore} → ${await evalJs(`document.querySelector('.h24-model-chip-label')?.textContent ?? ''`)}）`);
  await shot('model-switched-notice');

  // —— 技能标签：选择 → 行内标签 → 发送 → 正式消息回显 → 档案落盘 ——
  await setDraft('/');
  await wait('slash 面板打开', async () => (await panelVisible()) === 'slash');
  await clickPanelItem(SKILL_NAME);
  await wait('行内技能标签', () => evalJs(`Boolean(document.querySelector('.text-composer-mirror .composer-inline-tag[data-kind="skill"]'))`));
  await setDraft(`${SKILL_NAME} 请按技能回答，一句话即可`);
  await shot('skill-tag-in-composer');
  await pressKey('Enter');
  await wait('用户消息回显技能标签', () => evalJs(`Boolean([...document.querySelectorAll('.h24-user-bubble .h63-msg-tag[data-kind="skill"]')].length)`), 60_000);
  await wait('回合收口', () => evalJs(`(async () => { const s = await window.hemiVoice.flowGetSnapshot((await window.hemiVoice.listConversations()).sessions[0].id); return s?.phase === 'idle'; })()`), 240_000);
  const skillTurn = await wait('档案落盘技能身份', () => {
    const archive = latestArchive();
    const turn = archive?.turns?.findLast((t) => Array.isArray(t.skills) && t.skills.length);
    return turn ?? null;
  }, 60_000);
  checks['7-技能标签贯穿（选择→消息→档案）'] = skillTurn?.skills?.[0]?.skillId === `project:${SKILL_NAME}`;
  const log1 = logText();
  checks['8-回合携带技能指令'] = log1.includes('携带显式技能（1 项）');
  console.log(`[063] 技能身份落档：${JSON.stringify(skillTurn?.skills)}`);
  await shot('skill-tag-in-message');

  // —— @ 四类候选与行内引用 ——
  await setDraft('@');
  await wait('@ 面板打开', async () => (await panelVisible()) === 'mention');
  await wait('工作流候选', () => evalJs(`Boolean([...document.querySelectorAll('.h24-mention-menu .h24-model-item')].find((el) => el.textContent.includes('063验证流程') && el.textContent.includes('v1')))`));
  await shot('at-groups');
  const groupOrder = await evalJs(`[...document.querySelectorAll('.h24-mention-menu .h63-panel-group')].map((el) => el.dataset.group).join(',')`);
  checks['9-@分组次序 工作流→文件→文件夹→对话'] = groupOrder === 'workflow,file,folder,conversation';
  console.log(`[063] @ 分组：${groupOrder}`);
  // 选工作流引用。
  await clickPanelItem('063验证流程');
  await wait('工作流行内标签', () => evalJs(`Boolean(document.querySelector('.text-composer-mirror .composer-inline-tag[data-kind="workflow"]'))`));
  // 再补一个文件引用。
  await setDraft('看看 @063验证流程 和 @');
  await wait('@ 面板再开', async () => (await panelVisible()) === 'mention');
  await wait('文件候选出现', () => evalJs(`Boolean([...document.querySelectorAll('.h24-mention-menu .h24-model-item')].find((el) => el.textContent.includes('notes-063.md')))`));
  await clickPanelItem('notes-063.md');
  await wait('文件行内标签', () => evalJs(`Boolean(document.querySelector('.text-composer-mirror .composer-inline-tag[data-kind="file"]'))`));
  await setDraft(await evalJs(`document.querySelector('textarea.text-composer-input').value`) + ' 只是引用测试，回复一句话即可');
  await shot('at-inline-tags');
  await pressKey('Enter');
  await wait('用户消息回显引用标签', () => evalJs(`Boolean(document.querySelector('.h24-user-bubble .h63-msg-tag[data-kind="workflow"]') && document.querySelector('.h24-user-bubble .h63-msg-tag[data-kind="file"]'))`), 60_000);
  await wait('回合收口', () => evalJs(`(async () => { const s = await window.hemiVoice.flowGetSnapshot((await window.hemiVoice.listConversations()).sessions[0].id); return s?.phase === 'idle'; })()`), 240_000);
  const refTurn = await wait('档案落盘引用身份', () => {
    const archive = latestArchive();
    const turn = archive?.turns?.findLast((t) => Array.isArray(t.references) && t.references.some((r) => r.kind === 'workflow'));
    return turn ?? null;
  }, 60_000);
  const kinds = (refTurn?.references ?? []).map((r) => r.kind).sort().join(',');
  checks['10-引用身份贯穿'] = kinds === 'file,workflow' && refTurn.references.find((r) => r.kind === 'workflow')?.workflowRevision === 1;
  const log2 = logText();
  checks['11-回合携带引用封装'] = log2.includes('携带引用（2 项）');
  await shot('at-tags-in-message');

  // —— 加号菜单：只剩文件工作对象，无截图 ——
  await evalJs(`(() => { [...document.querySelectorAll('.h37-tool')].find((el) => el.getAttribute('aria-label')?.includes('附加'))?.click(); return true; })()`);
  const menuText = await wait('加号菜单打开', () => evalJs(`(() => { const menu = document.querySelector('.h37-attach-menu'); return menu ? menu.textContent : null; })()`));
  checks['12-加号菜单去截图'] = menuText.includes('选中文件') && !menuText.includes('截图');
  await evalJs(`(() => { document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return true; })()`).catch(() => {});
  await pressKey('Escape');

  // —— 重载后草稿标签恢复 ——
  await setDraft('/');
  await wait('slash 面板打开', async () => (await panelVisible()) === 'slash');
  await clickPanelItem(SKILL_NAME);
  await wait('行内技能标签', () => evalJs(`Boolean(document.querySelector('.text-composer-mirror .composer-inline-tag[data-kind="skill"]'))`));
  await setDraft(`${SKILL_NAME} 草稿不发送（重载验证）`);
  await sleep(900); // 等防抖落盘（400ms）。
  await evalJs('location.reload()');
  for (let i = 0; i < 120; i += 1) {
    if (await evalJs('window.hemiVoice && Boolean(document.querySelector("textarea"))')) break;
    await sleep(500);
  }
  await sleep(1200); // 草稿恢复与镜像渲染。
  const restoredDraft = await evalJs(`document.querySelector('textarea.text-composer-input').value`);
  const restoredTag = await evalJs(`Boolean(document.querySelector('.text-composer-mirror .composer-inline-tag[data-kind="skill"]'))`);
  checks['13-重载草稿恢复标签'] = restoredDraft.includes(SKILL_NAME) && Boolean(restoredTag);
  await shot('draft-restored');

  checks['14-零renderer错误'] = consoleErrors.length === 0;
  if (consoleErrors.length) console.warn(`[063] renderer errors：${JSON.stringify(consoleErrors.slice(0, 8))}`);
} finally {
  shutdown();
  await sleep(1_500);
  try { ws.close(); } catch { /* 已关 */ }
  if (viteLogFd != null) fs.closeSync(viteLogFd);
}

fs.writeFileSync(path.join(evidenceDir, 'checks.json'), JSON.stringify({ checks, mark: MARK, userData: UD }, null, 2));
const failed = Object.entries(checks).filter(([, ok]) => !ok);
console.log(`HEMI_063_RESULT=${JSON.stringify({ checks, failed: failed.map(([k]) => k) })}`);
if (failed.length) {
  console.error(`[063] 未过项：${failed.map(([k]) => k).join(' | ')}`);
  process.exit(1);
}
console.log('[063] 全部通过');
