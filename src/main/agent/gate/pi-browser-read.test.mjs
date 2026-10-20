import assert from 'node:assert/strict';
import test from 'node:test';
import hemiBrowser from './pi-browser.mjs';

function setup(request) {
  const tools = {}, ops = [];
  const bridge = {
    ensureReady: async () => {}, noteSession() {},
    async request(op, args) { ops.push({ op, args }); return request(op, args); },
  };
  hemiBrowser({ registerTool(tool) { tools[tool.name] = tool; } }, { config: { enabled: true }, bridge });
  return { tools, ops };
}
const page = { title: '目标页', url: 'https://example.com/target', text: '本次唯一正文 NAV_READ_001' };
const navigate = { ...page, session: { windowId: 1, tabId: 2 } };

test('导航兼容：不传 read 只打开，不额外读取或等待', async () => {
  const { tools, ops } = setup(async () => navigate);
  const out = await tools.browser_navigate.execute('n', { url: page.url }, null);
  assert.deepEqual(ops.map(x => x.op), ['session.navigate']);
  assert.match(out.content[0].text, /已打开/);
  assert.doesNotMatch(out.content[0].text, /NAV_READ_001/);
});

test('合并读取：加载占位变化后返回本次稳定正文，只导航一次，保留局部和截断参数', async () => {
  let reads = 0;
  const { tools, ops } = setup(async op => {
    if (op === 'session.navigate') return navigate;
    if (op === 'tab.netQuiet') return { quiet: true };
    return { ...page, text: ++reads === 1 ? '加载中' : page.text + 'x'.repeat(500) };
  });
  const out = await tools.browser_navigate.execute('r', { url: page.url, read: true, selector: '#content', maxChars: 200 }, null);
  assert.equal(out.details.navigationSucceeded, true);
  assert.equal(out.details.readStatus, 'complete');
  assert.equal(out.details.truncated, true);
  assert.match(out.content[0].text, /NAV_READ_001/);
  assert.doesNotMatch(out.content[0].text, /加载中/);
  assert.equal(ops.filter(x => x.op === 'session.navigate').length, 1);
  assert.ok(ops.filter(x => x.op === 'tab.extract').every(x => x.args.selector === '#content'));
  const reread = await tools.browser_extract.execute('r2', { selector: '#content' }, null);
  assert.match(reread.content[0].text, /NAV_READ_001/);
});

test('读取故障保留已导航事实，明确只重读且不自动再开页', async () => {
  const { tools, ops } = setup(async op => {
    if (op === 'session.navigate') return navigate;
    throw new Error('注入提取失败');
  });
  const out = await tools.browser_navigate.execute('f', { url: page.url, read: true }, null);
  assert.equal(out.isError, true);
  assert.equal(out.details.navigationSucceeded, true);
  assert.equal(out.details.readStatus, 'failed');
  assert.match(out.content[0].text, /已打开.+注入提取失败/);
  assert.match(out.content[0].text, /browser_extract 重读当前页/);
  assert.deepEqual(ops.map(x => x.op), ['session.navigate', 'tab.extract']);
});

test('动态页 selector 稍后挂载时继续读取，不把未就绪误判成导航失败', async () => {
  let reads = 0;
  const { tools, ops } = setup(async op => {
    if (op === 'session.navigate') return navigate;
    if (op === 'tab.netQuiet') return { quiet: true };
    if (++reads < 3) throw new Error('页面上找不到元素：#later');
    return page;
  });
  const out = await tools.browser_navigate.execute('spa', { url: page.url, read: true, selector: '#later' }, null);
  assert.equal(out.details.readStatus, 'complete');
  assert.match(out.content[0].text, /NAV_READ_001/);
  assert.equal(ops.filter(x => x.op === 'session.navigate').length, 1);
});

test('后台延迟网络请求开始后重新等安静，不能复用首次 quiet 提前返回占位正文', async () => {
  let quietCalls = 0;
  const { tools } = setup(async op => {
    if (op === 'session.navigate') return navigate;
    if (op === 'tab.netQuiet') { quietCalls += 1; return { quiet: true }; }
    return { ...page, text: quietCalls < 2 ? '加载中' : page.text };
  });
  const out = await tools.browser_navigate.execute('delayed', { url: page.url, read: true }, null);
  assert.ok(quietCalls >= 2, '必须重新观察延迟启动的网络');
  assert.equal(out.details.readStatus, 'complete');
  assert.match(out.content[0].text, /NAV_READ_001/);
  assert.doesNotMatch(out.content[0].text, /加载中/);
});

test('停止先证明读取在途：取消后不再等待或提取，保留已打开事实', async () => {
  const controller = new AbortController();
  let started, release;
  const inFlight = new Promise(resolve => { started = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const { tools, ops } = setup(async op => {
    if (op === 'session.navigate') return navigate;
    started(); return pending;
  });
  const result = tools.browser_navigate.execute('s', { url: page.url, read: true }, controller.signal);
  await inFlight;
  controller.abort(); release(page);
  const out = await result;
  assert.equal(out.details.navigationSucceeded, true);
  assert.equal(out.details.readStatus, 'aborted');
  assert.deepEqual(ops.map(x => x.op), ['session.navigate', 'tab.extract']);
  assert.match(out.content[0].text, /正文读取已中断/);
});

test('网络未安静时返回观察正文并标记不稳定，不虚报完成', async () => {
  const { tools } = setup(async op => op === 'session.navigate' ? navigate : op === 'tab.netQuiet' ? { quiet: false } : page);
  const out = await tools.browser_navigate.execute('u', { url: page.url, read: true }, null);
  assert.equal(out.details.readStatus, 'unstable');
  assert.match(out.content[0].text, /NAV_READ_001/);
  assert.match(out.content[0].text, /尚未确认稳定/);
});
