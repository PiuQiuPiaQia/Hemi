// 036 验收 · 工具级真机 harness：不经 LLM，直接驱动 pi-vision/pi-ax 注册的
// 8 个工具（screen_view/ui_list/ui_click/ui_type/ui_key/ui_scroll/ui_tree/ui_act）
// 对真实 TextEdit 走完整链路（扩展 → cua-client 桥 → 原生驱动 → 系统窗口）。
//
// 用法：先 `open -a TextEdit /tmp/hemi-cua-spike.txt`（或任意文本文档），
// 再 `node scripts/verify-cua-tools.mjs`。exit 0 = 全过。
import { execFileSync } from 'node:child_process';

import hemiVision from '../src/main/agent/gate/pi-vision.mjs';
import hemiAx from '../src/main/agent/gate/pi-ax.mjs';
import { cua } from '../src/main/agent/gate/cua-client.mjs';

/** 假 pi：只捕获 registerTool，记录 onUpdate 流。 */
function fakePi() {
  const tools = new Map();
  return {
    tools,
    registerTool: (spec) => tools.set(spec.name, spec),
  };
}

const results = [];
function record(id, ok, note) {
  results.push({ id, ok, note: String(note).slice(0, 180) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${String(note).slice(0, 180)}`);
}
const textOf = (out) => out?.content?.map((c) => c.text ?? '').join(' ') ?? '';
const hasImage = (out) => Boolean(out?.content?.some((c) => c.type === 'image'));

// --- 准备靶子 ---
try {
  execFileSync('osascript', ['-e', 'tell application "TextEdit" to activate']);
  await new Promise((r) => setTimeout(r, 500));
} catch { /* 已开就行 */ }

const pi = fakePi();
hemiVision(pi, { config: { enabled: true } });
hemiAx(pi, { config: { enabled: true } });
const tool = (name) => {
  const t = pi.tools.get(name);
  if (!t) throw new Error(`工具 ${name} 未注册`);
  return (params) => t.execute('id', params, undefined);
};

try {
  // T1 · ui_list：拿到 TextEdit 的 pid/windowId
  const list = await tool('ui_list')({});
  const apps = list.details?.apps ?? [];
  const te = apps.find((a) => a.name === 'TextEdit');
  const win = te?.windows?.[0];
  record('T1-ui_list', Boolean(te && win?.windowId), `apps=${apps.length}；TextEdit pid=${te?.pid} windowId=${win?.windowId}`);
  if (!win) throw new Error('没有 TextEdit 窗口：先 open -a TextEdit 一个文档');
  const target = { pid: te.pid, windowId: win.windowId, processName: te.name, windowTitle: win.title };

  // T2 · screen_view(target)：窗口截图
  const shot = await tool('screen_view')({ target });
  record('T2-screen_view', hasImage(shot) && shot.details?.actionState === undefined,
    `${textOf(shot).slice(0, 80)}；附图=${hasImage(shot)}`);

  // T3 · ui_type（中文，默认附图核验）
  const marker = `〔036验收 ${new Date().toISOString().slice(11, 19)}〕`;
  const typed = await tool('ui_type')({ text: marker, target });
  const afterType = await cua.windowState({ pid: te.pid, windowId: win.windowId, includeTree: true, timeoutMs: 2500 });
  const landed = (afterType.elements ?? []).some((el) => (el.value ?? '').includes(marker));
  record('T3-ui_type', typed.details?.actionState === 'executed' && hasImage(typed) && landed,
    `${textOf(typed).slice(0, 60)}；AX 复查${landed ? '命中落字' : '未见文本'}`);

  // T4 · ui_key：cmd+a（全选，不破坏——随后键回内容）
  const keyed = await tool('ui_key')({ combo: 'cmd+a', target });
  record('T4-ui_key', keyed.details?.actionState === 'executed', textOf(keyed).slice(0, 90));

  // T5 · ui_click：窗口中部坐标（后台路由）
  const clicked = await tool('ui_click')({ x: 200, y: 200, target });
  record('T5-ui_click', clicked.details?.actionState === 'executed', textOf(clicked).slice(0, 90));

  // T6 · ui_scroll：向下 3 行
  const scrolled = await tool('ui_scroll')({ deltaY: -3, target });
  record('T6-ui_scroll', scrolled.details?.actionState === 'executed', textOf(scrolled).slice(0, 90));

  // T7 · ui_tree：元素表 + 别名
  const tree = await tool('ui_tree')({ app: 'TextEdit' });
  const treeText = textOf(tree);
  const aliases = [...treeText.matchAll(/\[(t\d+)\]/g)].map((m) => m[1]);
  record('T7-ui_tree', aliases.length >= 8 && /元素树/.test(treeText),
    `${aliases.length} 个别名；${treeText.split('\n')[0].slice(0, 70)}`);

  // T8 · ui_act：set_value 元素设值（AXTextArea 不支持 AXPress——文本区按契约
  // 走设值/坐标路线，验收记录见需求文档）→ press 回车，两步首败即停。
  const areaAlias = treeText.match(/\[(t\d+)\] AXTextArea/)?.[1] ?? aliases[0];
  const acted = await tool('ui_act')({
    actions: [
      { op: "set_value", ref: areaAlias, value: "036 ui_act set_value 落字" },
      { op: 'press', combo: 'return' },
    ],
  });
  const actText = textOf(acted);
  const afterAct = await cua.windowState({ pid: te.pid, windowId: win.windowId, includeTree: true, timeoutMs: 2500 });
  const actLanded = (afterAct.elements ?? []).some((el) => (el.value ?? '').includes('036 ui_act set_value 落字'));
  record('T8-ui_act', actLanded && !actText.includes('✗'), `${actText.split('\n').slice(0, 3).join(' | ').slice(0, 140)}；AX 复查${actLanded ? '命中' : '未见'}`);

  // T9 · AX 盲降级信号：对 Hemi 自己（Electron 自绘区）不验，改验裸 pid 不存在时的 ui_tree 文案
  const blind = await tool('ui_tree')({ app: '不存在的应用XYZ' });
  record('T9-tree-miss', /没找到可用窗口/.test(textOf(blind)), textOf(blind).slice(0, 90));
} catch (e) {
  record('harness-fatal', false, `${e?.message ?? e}`);
} finally {
  await cua.dispose();
}

const ok = results.filter((r) => r.ok).length;
console.log(`\nHEMI_CUA_TOOLS_RESULT ${JSON.stringify({ pass: ok, total: results.length })}`);
process.exit(ok === results.length ? 0 : 1);
