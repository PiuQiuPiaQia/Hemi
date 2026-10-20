// Hemi 浏览器控制 · 页面侧逻辑源（021 R-06/07/11）
//
// 这里存放的是「注入页面执行的函数源码字符串」与随附的纯逻辑常量。
// service_worker.js 经 importScripts 取用（globalThis.HEMI_PAGE_LOGIC），
// Node 单测直接 new Function 提取同一份源码跑行为断言——生产与回归用例
// 永远引用同一份实现，不再出现「复现脚本在临时目录、源码里没有用例」的断层。
//
// 安全要点（review 基线 2026-09-21 的 P1 修复落点）：
//  - SNAPSHOT_SOURCE 在【隔离世界】执行：引用表 window.__hemiRefs 对页面
//    主世界脚本不可见不可写（AC-06）；
//  - 密码/隐藏输入框的 value 永不读取，密码框不进入候选（AC-07）；
//  - 结果证据（可见正文节选）与快照摘要（digest）供核验与无进展判定使用，
//    正文采集跳过表单控件内容（textarea 值不进证据）。

/** 可键入的 input 类型（021 R-11：textarea 与 email/url 等文本类都能成为输入目标）。 */
const SAFE_TEXT_TYPES = ['text', 'search', 'tel', 'url', 'email', 'number', ''];

/** djb2 哈希（页面侧与 Node 侧同源）：快照摘要与证据摘要的压缩指纹。 */
const HASH_SOURCE = `(s) => {
  var h = 5381;
  var str = String(s || '');
  for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}`;

/**
 * 结果证据采集（021 R-07；0.2.2 复盘批次改视口优先）：可见正文节选，跳过
 * SCRIPT/STYLE/表单控件——输入框当前值（含自动填充的敏感值）不进证据。
 * 0.2.2 真机复盘（携程列表页）：文档序前几百字被导航/页脚占满，核验判据指向
 * 的结果区一个字都进不来——改为先收视口内文本、再按文档序补足；重复文本
 * （日历条等重复渲染的区块）只记一次，省下的预算让给未见过内容。
 * 有界：最多采集 cap 字符、遍历 cap*25 个文本节点，truncated 如实标注。
 */
const EVIDENCE_SOURCE = `(cap) => {
  var root = document.body || document.documentElement;
  var vh = window.innerHeight || 0;
  var inView = [];
  var rest = [];
  var visited = 0;
  var total = 0;
  var seen = new Set();
  if (root && document.createTreeWalker) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        var p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        var tag = p.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT' || tag === 'OPTION') return NodeFilter.FILTER_REJECT;
        if (p.offsetParent === null && getComputedStyle(p).position !== 'fixed') return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var node;
    while ((node = walker.nextNode())) {
      visited += 1;
      if (visited > cap * 25) break;
      var text = String(node.nodeValue || '').replace(/\\s+/g, ' ').trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      total += text.length;
      var r = null;
      try { r = node.parentElement.getBoundingClientRect ? node.parentElement.getBoundingClientRect() : null; } catch (e) { r = null; }
      var top = r && typeof r.top === 'number' ? r.top : 0;
      var bottom = r ? (typeof r.bottom === 'number' ? r.bottom : top + (r.height || 0)) : 0;
      if (vh > 0 && bottom > 0 && top < vh) inView.push(text);
      else rest.push(text);
    }
  }
  var head = '';
  var i;
  for (i = 0; i < inView.length && head.length < cap; i++) head += (head ? ' ' : '') + inView[i];
  var tail = '';
  for (i = 0; i < rest.length && head.length + tail.length < cap; i++) tail += (tail ? ' ' : '') + rest[i];
  var chars = (head + (tail ? (head ? ' ' : '') + tail : '')).slice(0, cap);
  return { excerpt: chars, textChars: total, truncated: total > chars.length || visited > cap * 25 };
}`;

/**
 * 下拉选项匹配（021 R-11）：空文本拒绝、精确且唯一优先、模糊多候选返回
 * 歧义——任何非 ok 结果都不修改 DOM。
 */
const PICK_OPTION_SOURCE = `(options, want) => {
  var norm = function (s) { return String(s == null ? '' : s).replace(/\\s+/g, ' ').trim(); };
  var text = norm(want);
  if (!text) return { status: 'empty' };
  var items = [];
  for (var i = 0; i < options.length; i++) {
    items.push({ value: options[i].value, text: norm(options[i].text) });
  }
  var hits = [];
  var k;
  for (k = 0; k < items.length; k++) if (items[k].text === text) hits.push(items[k]);
  if (hits.length === 1) return { status: 'ok', value: hits[0].value, match: 'exact' };
  if (hits.length > 1) return { status: 'ambiguous', matches: hits.length };
  for (k = 0; k < items.length; k++) if (items[k].text && items[k].text.indexOf(text) !== -1) hits.push(items[k]);
  if (hits.length === 1) return { status: 'ok', value: hits[0].value, match: 'contains' };
  if (hits.length > 1) return { status: 'ambiguous', matches: hits.length };
  return { status: 'no-match' };
}`;

/**
 * 021 快照 v2（在隔离世界执行）：元素表 + 引用留存 + 摘要 + 证据。
 * 与 020 版的差异：
 *  - 密码/隐藏输入框永不读取 value，密码框不进候选（AC-07）；
 *  - textarea 与 email/url 等文本类 input 归入 textbox（R-11）；
 *  - select 行带当前选中项文字，checkbox/radio 行带勾选状态（AC-07/R-08）；
 *  - 返回 v:2、digest（元素表指纹）、scrollY、evidence（正文节选+指纹）、
 *    truncated（候选预算截断）、coverage（观察边界：不含 iframe/shadow DOM）。
 * 注意：本源码会被内联进页面，内部禁止使用反引号与 ${} 插值。
 */
const SNAPSHOT_SOURCE = `() => {
  var hashOf = ${HASH_SOURCE};
  var collectEvidence = ${EVIDENCE_SOURCE};
  var SAFE = ${JSON.stringify(SAFE_TEXT_TYPES)};
  var clean = function (s) { return String(s || '').replace(/\\s+/g, ' ').trim().slice(0, 40); };
  var visible = function (el) {
    if (!el.isConnected) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.05;
  };
  var inputType = function (el) { return String(el.getAttribute('type') || '').toLowerCase(); };
  var labelOf = function (el) {
    var t = el.getAttribute('aria-label') || el.getAttribute('title') || '';
    var tag = el.tagName;
    var type = tag === 'INPUT' ? inputType(el) : '';
    if (!t && (tag === 'INPUT' || tag === 'TEXTAREA')) {
      // 密码/隐藏框的 value 永不读取（AC-07）：标签缺失时给中性占位，不是空串。
      t = el.getAttribute('placeholder') || (type === 'password' ? '' : tag === 'TEXTAREA' ? String(el.value || '') : (SAFE.indexOf(type) !== -1 ? String(el.value || '') : ''));
    }
    if (!t && type === 'password') t = '(密码框)';
    if (!t) t = el.innerText || el.textContent || '';
    return clean(t);
  };
  var seen = new Set();
  var nodes = [];
  var add = function (el) { if (el && !seen.has(el)) { seen.add(el); nodes.push(el); } };
  var SEL = 'a[href], button, input, select, textarea, li, [role=button], [role=link],'
    + ' [role=tab], [role=option], [role=menuitem], [role=checkbox], [onclick]';
  document.querySelectorAll(SEL).forEach(add);
  var DATE_BOX = '[class*="calendar"],[id*="calendar"],[class*="date_range"],[id*="date_range"]';
  document.querySelectorAll(DATE_BOX).forEach(function (box) {
    box.querySelectorAll('td, li, div, span, a').forEach(add);
  });

  window.__hemiRefs = [];
  var lines = [];
  var click = [], type = [], select = [];
  var seenLine = new Set();
  var truncated = false;
  for (var idx = 0; idx < nodes.length; idx++) {
    var el = nodes[idx];
    if (!visible(el)) continue;
    // 密码框整体不进候选：值不可读取，动作也不经 JEV（AC-07）。
    if (el.tagName === 'INPUT' && inputType(el) === 'password') continue;
    var disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true';
    var kind = null;
    var inType = el.tagName === 'INPUT' ? inputType(el) : '';
    if (el.tagName === 'SELECT' && !disabled) kind = 'select';
    else if (el.tagName === 'TEXTAREA' && !disabled && !el.readOnly) kind = 'textbox';
    else if (el.tagName === 'INPUT' && !disabled && !el.readOnly
      && SAFE.indexOf(inType) !== -1 && inType !== 'password') kind = 'textbox';
    else if (!disabled) kind = 'clickable';
    if (!kind) continue;
    var label = labelOf(el);
    var val = (kind === 'textbox') ? clean(el.value) : '';
    var state = '';
    if (kind === 'select') {
      var opt = el.options && el.selectedIndex >= 0 ? el.options[el.selectedIndex] : null;
      var picked = clean(opt ? opt.textContent : '');
      if (picked) state = ' · 选中:' + picked;
    } else if (inType === 'checkbox' || inType === 'radio') {
      state = el.checked ? ' · 已勾选' : ' · 未勾选';
    }
    var line = '[' + (window.__hemiRefs.length + 1) + '] ' + kind
      + (el.id ? ' (' + el.id + ')' : '') + ' ' + (label || '(无标签)') + (val ? ' · ' + val : '') + state;
    if (seenLine.has(line)) continue;
    seenLine.add(line);
    window.__hemiRefs.push(el);
    lines.push(line);
    var entry = { i: String(window.__hemiRefs.length), text: line };
    if (kind === 'select') select.push(entry);
    else if (kind === 'textbox') type.push(entry);
    else click.push(entry);
    if (click.length + type.length + select.length >= 120) { truncated = true; break; }
  }
  // 0.2.2：800→1200——内容型页面视口内的结果区常需要更多字符才覆盖判据。
  var evidence = collectEvidence(1200);
  return {
    v: 2,
    title: document.title || '',
    url: location.href,
    scrollY: Math.round(window.scrollY || 0),
    lines: lines,
    digest: hashOf(lines.join('\\n')),
    click: click, type: type, select: select,
    refs: window.__hemiRefs.length,
    truncated: truncated || Boolean(evidence.truncated),
    coverage: 'main-frame',
    evidence: {
      excerpt: evidence.excerpt,
      textChars: evidence.textChars,
      digest: hashOf(String(evidence.excerpt) + '|' + String(evidence.textChars)),
      truncated: Boolean(evidence.truncated),
    },
  };
}`;

globalThis.HEMI_PAGE_LOGIC = {
  SAFE_TEXT_TYPES,
  HASH_SOURCE,
  EVIDENCE_SOURCE,
  PICK_OPTION_SOURCE,
  SNAPSHOT_SOURCE,
};
