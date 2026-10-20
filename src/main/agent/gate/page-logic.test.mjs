// 021 page-logic 行为单测：扩展页面侧源码在 Node 里用假 DOM 直测。
// 生产（service_worker 经 importScripts）与回归用例引用同一份实现——
// review 基线的复现脚本从此进源码测试目录，不再散落临时目录。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');
const PAGE_LOGIC_PATH = join(HERE, 'extensions', 'chrome-extension', 'page-logic.js');

const LOGIC = new Function(
  `${readFileSync(PAGE_LOGIC_PATH, 'utf8')}; return globalThis.HEMI_PAGE_LOGIC;`,
)();

// ---------- 假 DOM（够 SNAPSHOT_SOURCE 跑通的最小集合） ----------

function fakeEl(spec = {}) {
  const {
    tag = 'DIV', id = '', type = '', value = '', text = '', checked = false,
    rect = { width: 80, height: 20 }, disabled = false, readOnly = false,
    attrs = {}, options = null, selectedIndex = -1, children = [],
  } = spec;
  const el = {
    tagName: tag.toUpperCase(),
    id,
    isConnected: true,
    disabled,
    readOnly,
    checked,
    value,
    options,
    selectedIndex,
    innerText: text,
    textContent: text,
    attrs,
    getAttribute(name) { return attrs[name] ?? null; },
    getBoundingClientRect() { return { left: rect.x ?? 0, top: rect.y ?? 0, width: rect.width, height: rect.height }; },
  };
  el.children = children;
  return el;
}

const STYLE_OK = { display: 'block', visibility: 'visible', opacity: '1', position: 'static' };

/** 安装假 document/location/window，跑快照源码。candidates 是候选元素序列。 */
function runSnapshot(candidates, { title = '测试页', href = 'https://test.example/x', bodyTextNodes = [], scrollY = 0, innerHeight = 0 } = {}) {
  const sandbox = {
    document: {
      title,
      body: fakeEl({ tag: 'BODY' }),
      querySelectorAll: (sel) => (sel.startsWith('a[href]') ? candidates : []),
      createTreeWalker: (root, type, filter) => {
        const nodes = bodyTextNodes.filter((n) => filter.acceptNode(n) === NodeFilterish.FILTER_ACCEPT);
        let i = 0;
        return { nextNode: () => (i < nodes.length ? nodes[i++] : null) };
      },
    },
    location: { href },
    getComputedStyle: () => STYLE_OK,
    NodeFilter: null,
    __scrollY: scrollY,
  };
  const NodeFilterish = { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 };
  sandbox.NodeFilter = NodeFilterish;
  const windowObj = { scrollY, innerHeight };
  const fn = new Function(
    'document', 'location', 'getComputedStyle', 'NodeFilter', 'window', 'Set',
    `return (${LOGIC.SNAPSHOT_SOURCE})();`,
  );
  return fn(sandbox.document, sandbox.location, sandbox.getComputedStyle, NodeFilterish, windowObj, Set);
}

function textNode(parent, value) {
  return { nodeValue: value, parentElement: parent };
}

// ---------- 快照：脱敏 / 表单分类 / 证据 / 摘要 ----------

test('AC-07：密码框不进候选，其值不出现在任何行；占位标签为中性文案', () => {
  const pwd = fakeEl({
    tag: 'INPUT', id: 'pwd', type: 'password', value: 'S3cret!密码', attrs: { type: 'password' },
  });
  const btn = fakeEl({ tag: 'BUTTON', id: 'ok', text: '登录' });
  const snap = runSnapshot([pwd, btn]);
  assert.ok(!JSON.stringify(snap).includes('S3cret'), '密码值不得进入快照任何字段');
  assert.equal(snap.lines.length, 1, '密码框不进候选');
  assert.match(snap.lines[0], /登录/);
  assert.equal(snap.refs, 1);
});

test('AC-07：无标签密码框行只出现中性占位，不泄露值', () => {
  const pwd = fakeEl({ tag: 'INPUT', id: '', type: 'password', value: 'topsecret', attrs: { type: 'password' } });
  const snap = runSnapshot([pwd]);
  assert.equal(snap.lines.length, 0, '密码框整体不进候选（021 裁定）');
});

test('R-11：textarea 与 email 输入框归入 textbox，可成为输入目标', () => {
  const area = fakeEl({ tag: 'TEXTAREA', id: 'bio', value: '旧简介', text: '旧简介' });
  const mail = fakeEl({ tag: 'INPUT', id: 'mail', type: 'email', value: '', attrs: { type: 'email' } });
  const snap = runSnapshot([area, mail]);
  assert.equal(snap.type.length, 2, 'textarea 与 email 都应进入 type 候选');
  assert.match(snap.lines[0], /textbox \(bio\)/);
  assert.match(snap.lines[1], /textbox \(mail\)/);
});

test('AC-07：select 行带当前选中项文字，checkbox 行带勾选状态', () => {
  const sel = fakeEl({
    tag: 'SELECT', id: 'seat', options: [
      { value: '1', text: '商务座', textContent: '商务座' },
      { value: '2', text: '二等座', textContent: '二等座' },
    ], selectedIndex: 1,
  });
  const box = fakeEl({ tag: 'INPUT', id: 'agree', type: 'checkbox', checked: true, attrs: { type: 'checkbox' }, text: '同意条款' });
  const snap = runSnapshot([sel, box]);
  assert.match(snap.lines[0], /select \(seat\)/);
  assert.match(snap.lines[0], /选中:二等座/);
  assert.match(snap.lines[1], /已勾选/);
  assert.equal(snap.select.length, 1);
});

test('R-08/R-10：digest 与 scrollY 进快照，内容变化摘要跟着变', () => {
  const btn = fakeEl({ tag: 'BUTTON', id: 'go', text: '查询' });
  const a = runSnapshot([btn], { scrollY: 0 });
  const b = runSnapshot([btn], { scrollY: 640 });
  assert.equal(a.v, 2);
  assert.equal(a.digest, runSnapshot([btn]).digest, '同一画面摘要稳定');
  assert.equal(a.scrollY, 0);
  assert.equal(b.scrollY, 640, 'scrollY 独立上报（进展签名由 act-policy 组合）');
  assert.equal(a.coverage, 'main-frame', '观察边界如实标注');
});

test('R-07：证据正文跳过表单控件内容，textarea 值不进节选；truncated 如实', () => {
  const area = fakeEl({ tag: 'TEXTAREA', id: 'secret-note', value: '机密备注内容' });
  const para = fakeEl({ tag: 'DIV', text: '' });
  const snap = runSnapshot([para], {
    bodyTextNodes: [
      textNode(para, '查询结果：G1 次列车 有票'),
      textNode(area, '机密备注内容'),
    ],
  });
  assert.match(snap.evidence.excerpt, /G1 次列车/);
  assert.ok(!snap.evidence.excerpt.includes('机密备注'), 'textarea 内容不得进证据节选');
  assert.equal(snap.evidence.truncated, false);
  assert.ok(snap.evidence.textChars >= '查询结果：G1 次列车 有票'.length);
});

test('0.2.2 复盘：证据节选视口优先——结果区文本排到文档序在前的页外文本前面，重复文本去重', () => {
  // 真机实录（携程列表页）：文档序前几百字是导航/页脚，结果区一个字都进不来。
  const nav = fakeEl({ tag: 'DIV', rect: { x: 0, y: 5000, width: 80, height: 20 } });   // 视口外（文档序在前）
  const para = fakeEl({ tag: 'DIV' });                                                    // 视口内（默认 rect top 0）
  const foot = fakeEl({ tag: 'DIV', rect: { x: 0, y: 9000, width: 80, height: 20 } });  // 视口外
  const snap = runSnapshot([nav], {
    innerHeight: 600,
    bodyTextNodes: [
      textNode(nav, '导航栏链接们'),
      textNode(para, '航班一 ¥1001'),
      textNode(para, '航班二 ¥1143'),
      textNode(para, '航班一 ¥1001'), // 重复渲染的同一文本 → 只记一次
      textNode(foot, '版权所有页脚'),
    ],
  });
  const ex = snap.evidence.excerpt;
  assert.ok(ex.indexOf('航班一 ¥1001') < ex.indexOf('导航栏链接们'), '视口内文本先于文档序在前的页外文本');
  assert.equal(ex.split('航班一 ¥1001').length - 1, 1, '重复文本只记一次');
  assert.match(ex, /版权所有页脚/, '预算富余时按文档序补足页外文本');
});

test('0.2.2 复盘：视口信息缺失（window.innerHeight 为 0）时退回文档序，不丢内容', () => {
  const para = fakeEl({ tag: 'DIV' });
  const snap = runSnapshot([para], {
    bodyTextNodes: [textNode(para, '第一段'), textNode(para, '第二段')],
  });
  assert.match(snap.evidence.excerpt, /第一段 第二段/);
});

test('AC-07：候选预算截断时 truncated 标注，不静默', () => {
  const many = Array.from({ length: 121 }, (_, i) => fakeEl({ tag: 'BUTTON', id: `b${i}`, text: `按钮${i}` }));
  const snap = runSnapshot(many);
  assert.equal(snap.lines.length, 120, '候选预算 120 生效');
  assert.equal(snap.truncated, true, '截断必须显式标注');
});

// ---------- 下拉匹配：精确且唯一 ----------

const OPTIONS = [
  { value: '1', text: '商务座' },
  { value: '2', text: '二等座' },
  { value: '3', text: '商务座（上）' },
];

const pickOption = new Function(`return (${LOGIC.PICK_OPTION_SOURCE});`)();

test('R-11：精确且唯一优先，多候选歧义不落值', () => {
  assert.deepEqual(pickOption(OPTIONS, '二等座'), { status: 'ok', value: '2', match: 'exact' });
  const ambiguous = pickOption([{ value: 'a', text: '商务座' }, { value: 'b', text: '商务座 ' }], '商务座');
  assert.equal(ambiguous.status, 'ambiguous');
  assert.ok(ambiguous.matches >= 2);
});

test('R-11：模糊唯一可含式命中，无匹配与空文本明确拒绝', () => {
  assert.deepEqual(pickOption(OPTIONS, '商务座（上）'), { status: 'ok', value: '3', match: 'exact' });
  const contains = pickOption([{ value: 'x', text: '北京南 (Beijingnan)' }], '北京南');
  assert.equal(contains.status, 'ok');
  assert.equal(contains.match, 'contains');
  assert.equal(pickOption(OPTIONS, '不存在的座位').status, 'no-match');
  assert.equal(pickOption(OPTIONS, '').status, 'empty');
  assert.equal(pickOption(OPTIONS, '   ').status, 'empty');
});

test('hash：同源实现稳定且区分输入', () => {
  const hash = new Function(`return (${LOGIC.HASH_SOURCE});`)();
  assert.equal(hash('abc'), hash('abc'));
  assert.notEqual(hash('abc'), hash('abd'));
  assert.ok(/^[0-9a-z]+$/.test(hash('')), '空串也返回可序列化指纹');
});
