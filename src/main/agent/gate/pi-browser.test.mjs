// pi-browser 单测：纯函数直测 + 经真实回环 WS 模拟 Chrome 扩展的工具面覆盖。
// 不触 userData；状态文件写进 mkdtemp。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { test } from 'node:test';

import {
  default as hemiBrowser,
  isValidHttpUrl,
  truncateText,
} from './pi-browser.mjs';
import {
  BRIDGE_PORTS,
  bridgeStateTransition,
  createBrowserBridgeService,
  detectOtherHubs,
} from '../../services/browser-bridge-service.mjs';

async function freePort() {
  // 让 OS 绑 port 0 现分配：随机猜在 Windows 上会撞 Hyper-V 保留段（EACCES）
  // 与其他进程（EADDRINUSE）——win 探针第 4 轮钓出；关闭后重绑的小竞态测试可接受。
  const srv = createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

/** 模拟 Chrome 扩展：按脚本应答 cmd（respond 回执可自定义）。 */
function dialExtension(port, { onCommand = () => ({ ok: true, data: {} }) } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { origin: 'chrome-extension://hemiext' },
    });
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'hello', version: 1 }));
      resolve({
        ws,
        close() {
          return new Promise((done) => {
            ws.addEventListener('close', () => done(), { once: true });
            ws.close();
          });
        },
      });
    });
    ws.addEventListener('error', () => reject(new Error('扩展连接失败')));
    ws.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.type === 'cmd') {
          // onCommand 返回 null＝故意不回执（测超时）；undefined＝默认成功回执。
          const outcome = onCommand(message);
          if (outcome === null) return;
          ws.send(JSON.stringify({ type: 'result', id: message.id, ...(outcome ?? { ok: true, data: {} }) }));
        }
      } catch {
        /* 非 JSON 忽略 */
      }
    });
  });
}

const TMP = mkdtempSync(join(tmpdir(), 'hemi-pibrowser-'));

test('isValidHttpUrl：http/https 放行，file/javascript/chrome 拒绝', () => {
  assert.ok(isValidHttpUrl('https://example.com'));
  assert.ok(isValidHttpUrl('http://localhost:3000/search?q=x'));
  assert.ok(isValidHttpUrl('  https://a.b  '));
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'chrome://settings',
    'ftp://x', 'example.com', '', null, 42]) {
    assert.equal(isValidHttpUrl(bad), false, `应拒绝：${String(bad)}`);
  }
});

test('truncateText：默认 1.2 万字、上限 3 万、下限 200', () => {
  assert.deepEqual(truncateText('短文本', 5000), { text: '短文本', truncated: false });
  const cut = truncateText('x'.repeat(20000), 12000);
  assert.equal(cut.truncated, true);
  assert.ok(cut.text.length > 12000 && cut.text.length < 12100, `截断长度异常：${cut.text.length}`);
  const capped = truncateText('x'.repeat(90000), 99999);
  assert.equal(capped.truncated, true);
  assert.ok(capped.text.length <= 30000 + 30, `硬上限失效：${capped.text.length}`);
  assert.equal(truncateText('x'.repeat(500), 0).text.length, 500); // 下限 200 但未超
});

test('bridgeStateTransition：off→starting→ready，断连回 starting，fatal 进 error', () => {
  let s = 'off';
  s = bridgeStateTransition(s, 'start');
  assert.equal(s, 'starting');
  s = bridgeStateTransition(s, 'client-hello');
  assert.equal(s, 'ready');
  s = bridgeStateTransition(s, 'client-gone');
  assert.equal(s, 'starting');
  s = bridgeStateTransition(s, 'client-hello');
  assert.equal(s, 'ready');
  assert.equal(bridgeStateTransition('ready', 'fatal'), 'error');
  assert.equal(bridgeStateTransition('off', 'client-hello'), 'off'); // off 不跳
  assert.equal(bridgeStateTransition('ready', 'stop'), 'off');
});

test('BRIDGE_PORTS 固定端口段（扩展侧重试同段）', () => {
  assert.deepEqual(BRIDGE_PORTS, [9467, 9468, 9469, 9470]);
});

test('环境开关：config 未启用时不注册任何工具（023 R-06 config 注入）', () => {
  const registered = [];
  hemiBrowser({ registerTool: (t) => registered.push(t.name) }, { config: {} });
  assert.deepEqual(registered, []);
});

test('工具面：navigate/extract/click/type/tabs/screenshot 经桥往返', async () => {
  const port = await freePort();
  const service = createBrowserBridgeService({ ports: [port], log: null, opTimeout: { default: 2000 } });
  const bridge = service.createClient({ taskId: 't-under-test' });
  const registered = {};
  hemiBrowser({ registerTool: (t) => { registered[t.name] = t; } }, { config: { enabled: true }, bridge });
  const sent = [];
  await bridge.start();
  try {
    // 工具在桥未启动时调用会自行启动；但 waitReady 需要扩展在 8s 内 hello。
    const dialed = dialExtension(port, {
      onCommand: (cmd) => {
        sent.push(cmd);
        if (cmd.op === 'session.navigate') {
          return { ok: true, data: { title: '示例页', url: cmd.params.url, session: { windowId: 7, tabId: 8 } } };
        }
        if (cmd.op === 'tab.extract') {
          return { ok: true, data: { title: '示例页', url: 'https://example.com', text: 'x'.repeat(500) } };
        }
        if (cmd.op === 'tab.click') return { ok: true, data: { hitText: '百度一下' } };
        if (cmd.op === 'tab.list') {
          return { ok: true, data: { tabs: [{ index: 0, title: '示例页', url: 'https://example.com', active: true }], session: { windowId: 7, tabId: 8 } } };
        }
        return { ok: true, data: {} };
      },
    });
    // 扩展接入与工具调用并发：桥由首次工具调用启动。
    const nav = await registered.browser_navigate.execute('t1', { url: 'https://example.com', taskTitle: '  对比三款轻薄本  ' }, null);
    assert.match(nav.content[0].text, /已打开：示例页/);
    assert.equal(sent[0].params.taskTitle, '对比三款轻薄本');
    assert.deepEqual(bridge.session, { windowId: 7, tabId: 8 });

    const extract = await registered.browser_extract.execute('t2', {}, null);
    assert.match(extract.content[0].text, /示例页/);
    assert.match(extract.content[0].text, /x{50}/);

    const click = await registered.browser_click.execute('t3', { selector: '#su' }, null);
    assert.match(click.content[0].text, /已点击 #su/);

    const tabs = await registered.browser_tabs.execute('t4', {}, null);
    assert.match(tabs.content[0].text, /本任务标签页 1 个/);

    await assert.rejects(
      registered.browser_navigate.execute('t5', { url: 'file:///etc/passwd' }, null),
      /只支持 http\/https/,
    );
    await assert.rejects(registered.browser_type.execute('t6', { text: '' }, null), /text 不能为空/);
    await dialed;
  } finally {
    await bridge.stop();
    await service.stopHub();
    rmSync(TMP, { recursive: true, force: true });
  }
});

test('扩展回执错误与命令超时都变成明确失败', async () => {
  const port = await freePort();
  const service = createBrowserBridgeService({ ports: [port], log: null, opTimeout: { default: 250 } });
  const bridge = service.createClient({ taskId: 't-under-test' });
  const registered = {};
  hemiBrowser({ registerTool: (t) => { registered[t.name] = t; } }, { config: { enabled: true }, bridge });
  await bridge.start();
  let failNext = false;
  const dialed = dialExtension(port, {
    onCommand: (cmd) => {
      if (failNext) return null; // 不回执 → 超时
      if (cmd.op === 'tab.click') return { ok: false, error: '找不到元素' };
      return { ok: true, data: {} };
    },
  });
  try {
    await registered.browser_navigate.execute('e0', { url: 'https://example.com' }, null);
    await assert.rejects(registered.browser_click.execute('e1', { selector: '#x' }, null), /找不到元素/);
    failNext = true;
    await assert.rejects(registered.browser_screenshot.execute('e2', {}, null), /超时/);
  } finally {
    await bridge.stop();
    await service.stopHub();
    await dialed;
  }
});

test('扩展断开：在途命令立刻失败，重连后恢复', async () => {
  const port = await freePort();
  const service = createBrowserBridgeService({ ports: [port], log: null, opTimeout: { default: 2000 } });
  const bridge = service.createClient({ taskId: 't-under-test' });
  const registered = {};
  hemiBrowser({ registerTool: (t) => { registered[t.name] = t; } }, { config: { enabled: true }, bridge });
  await bridge.start();
  let heldExtract = false;
  let ext = await dialExtension(port, {
    onCommand: (cmd) => {
      // 第一次 extract 故意不回执：制造一个「在途命令」，随后断开应立刻失败。
      if (cmd.op === 'tab.extract' && !heldExtract) {
        heldExtract = true;
        return null;
      }
      return { ok: true, data: {} };
    },
  });
  try {
    await registered.browser_navigate.execute('d0', { url: 'https://example.com' }, null);
    const inFlight = registered.browser_extract.execute('d1', {}, null);
    inFlight.catch(() => {}); // 先挂接防未处理拒绝；断言仍走 assert.rejects
    await new Promise((r) => setTimeout(r, 80));
    await ext.close(); // 断开 → 在途命令应立刻失败，不是等超时
    await assert.rejects(inFlight, /连接断开/);
    ext = await dialExtension(port); // 重连恢复
    const ok = await registered.browser_navigate.execute('d2', { url: 'https://example.com' }, null);
    assert.match(ok.content[0].text, /已打开/);
  } finally {
    await bridge.stop();
    await service.stopHub();
    await Promise.race([ext.close(), new Promise((r) => setTimeout(r, 500))]);
  }
});

// ---------- 020 · browser_act（Jev 步进循环） ----------

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BROWSER_ACT_TOOLS } from './policy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_SW = path.join(HERE, '..', '..', '..', '..', 'extensions', 'chrome-extension', 'service_worker.js');
const REAL_PAGE_LOGIC = path.join(HERE, '..', '..', '..', '..', 'extensions', 'chrome-extension', 'page-logic.js');

/** 构造 systemone 响应体（形状取自实验实录；021 起目标答案带置信度）。 */
function opResponse(op, { confidence = 0.9, target = null, targetConfidence = null } = {}) {
  const answers = { operation: { type: 'choice', choice: op, confidence } };
  if (target != null) {
    answers[`${op === 'CLICK' ? 'click' : op === 'TYPE_TEXT' ? 'type' : 'select'}_target`] = {
      choice: String(target),
      confidence: targetConfidence ?? confidence,
    };
  }
  return { model: 'jev-test', answers, usage: { input_tokens: 10 } };
}
const noulResponse = (value) => ({ model: 'jev-test', answers: { ok: { noul: value } } });

/** 021 快照协议 v2：digest/scrollY/evidence 由扩展上报（page-logic.test 覆盖其生成）。 */
const SNAP_OK = {
  v: 2,
  title: '12306', url: 'https://kyfw.12306.cn/init',
  scrollY: 0,
  digest: 'sig-abc',
  lines: ['[1] link 首页', '[2] textbox (fromStationText) 简', '[3] clickable (query_ticket) 查询'],
  click: [{ i: '1', text: '[1] link 首页' }, { i: '3', text: '[3] clickable (query_ticket) 查询' }],
  type: [{ i: '2', text: '[2] textbox (fromStationText) 简' }], select: [], refs: 3,
  truncated: false,
  coverage: 'main-frame',
  evidence: { excerpt: '查询结果：车次列表', textChars: 300, digest: 'evi-abc', truncated: false },
};

/** 安装假 Jev 端点：劫持 globalThis.fetch（客户端在 hemiBrowser 调用时捕获）。 */
function fakeJev({ ops = [], noul = [] } = {}) {
  const bodies = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (body.questions?.ok) {
      return { ok: true, status: 200, json: async () => noul.length ? noul.shift() : noulResponse(1) };
    }
    const next = ops.length ? ops.shift() : opResponse('DONE');
    return { ok: true, status: 200, json: async () => (typeof next === 'function' ? next(body) : next) };
  };
  return {
    bodies,
    restore() { globalThis.fetch = original; },
  };
}

function permissionFile(mode) {
  // 自建独立临时目录：上游用例的 finally 会 rmSync 掉共享 TMP。
  const dir = mkdtempSync(join(tmpdir(), 'hemi-pibrowser-perm-'));
  const file = path.join(dir, `perm-${mode}.json`);
  writeFileSync(file, JSON.stringify({ mode }));
  return file;
}

/** 023：browser_act 开关与 Jev 配置经显式 config 注入（迁移前是 HEMI_PI_BROWSER_ACT 等 env）。 */
const ACT_CONFIG = {
  enabled: true,
  act: true,
  jev: { apiKey: 'test-key', baseUrl: 'https://jev.test/typesafe', model: 'jev-test' },
};

test('browser_act：两步完成（点击→DONE），两级核验通过即 done', async () => {
  const port = await freePort();
  const service = createBrowserBridgeService({ ports: [port], log: null, opTimeout: { default: 2000 } });
  const bridge = service.createClient({ taskId: 't-under-test' });
  const registered = {};
  const jev = fakeJev({
    ops: [opResponse('CLICK', { confidence: 0.9, target: 3 }), opResponse('DONE', { confidence: 0.85 })],
    noul: [noulResponse(0.95)],
  });
  hemiBrowser({ registerTool: (t) => { registered[t.name] = t; } }, {
    config: { ...ACT_CONFIG, permissionStatePath: permissionFile('full') },
    bridge,
  });
  await bridge.start();
  const refActs = [];
  const dialed = dialExtension(port, {
    onCommand: (cmd) => {
      if (cmd.op === 'tab.snapshot') return { ok: true, data: SNAP_OK };
      if (cmd.op === 'tab.refAct') { refActs.push(cmd.params); return { ok: true, data: { status: 'ok', label: '查询', id: 'query_ticket' } }; }
      return { ok: true, data: {} };
    },
  });
  try {
    assert.ok(registered.browser_act, '开关与 key 齐备时应注册 browser_act');
    assert.ok(BROWSER_ACT_TOOLS.includes('browser_act'), 'browser_act 应在问档动作工具表');
    const result = await registered.browser_act.execute(
      'a1',
      { goal: '点击查询按钮', successCriteria: '结果列表出现' },
      null,
    );
    assert.match(result.content[0].text, /子目标已完成：2 步/);
    assert.equal(result.details.actionState, 'executed');
    assert.equal(result.details.status, 'done');
    assert.equal(result.details.steps[0].confidence, 0.9);
    assert.equal(result.details.steps[0].operationConfidence, 0.9, '021 双置信度分别留痕');
    assert.equal(result.details.steps[0].targetConfidence, 0.9);
    assert.equal(result.details.executedEffects, 1, 'R-09：ok 回执的副作用动作计数');
    assert.ok(result.details.reason == null);
    // refAct 带 dispatchId（R-09 派发去重）。
    assert.equal(refActs.length, 1);
    assert.equal(refActs[0].index, 3);
    assert.equal(refActs[0].action, 'click');
    assert.ok(refActs[0].dispatchId, 'refAct 应带 dispatchId');
    // 请求形状：第一次带 click_target 问题；核验走 noul 问题。
    assert.ok(jev.bodies[0].questions.click_target, '决策请求应带 click_target');
    assert.ok(jev.bodies[2].questions.ok, '核验请求应是 noul');
    assert.match(jev.bodies[2].questions.ok.instructions, /结果列表出现/);
  } finally {
    jev.restore();
    await bridge.stop();
    await service.stopHub();
    await dialed;
  }
});

test('browser_act：低置信副作用步不执行并给出降级指引（042：full 档退役）', async () => {
  const port = await freePort();
  const service = createBrowserBridgeService({ ports: [port], log: null, opTimeout: { default: 2000 } });
  const bridge = service.createClient({ taskId: 't-under-test' });
  const registered = {};
  const jev = fakeJev({ ops: [opResponse('CLICK', { confidence: 0.5, target: 3 })] });
  hemiBrowser({ registerTool: (t) => { registered[t.name] = t; } }, { config: { ...ACT_CONFIG, permissionStatePath: permissionFile('confirm') }, bridge });
  await bridge.start();
  let refActSeen = false;
  const dialed = dialExtension(port, {
    onCommand: (cmd) => {
      if (cmd.op === 'tab.snapshot') return { ok: true, data: SNAP_OK };
      if (cmd.op === 'tab.refAct') { refActSeen = true; return { ok: true, data: { status: 'ok', label: '', id: '' } }; }
      return { ok: true, data: {} };
    },
  });
  try {
    const result = await registered.browser_act.execute('a1', { goal: '点查询', successCriteria: '结果出现' }, null);
    assert.equal(result.details.status, 'low-confidence');
    assert.equal(result.details.actionState, 'not-executed');
    assert.equal(refActSeen, false, 'confirm 档低置信步不得执行');
    assert.match(result.content[0].text, /browser_click/);
  } finally {
    jev.restore();
    await bridge.stop();
    await service.stopHub();
    await dialed;
  }

});

test('browser_act：原地重复熔断与 TYPE_TEXT 缺 typeText 的明确报错', async () => {
  // 决策永远返回同一个 TYPE_TEXT：客户端在 hemiBrowser 调用时捕获 fetch，
  // 所以必须先装 fake 再创建工具。（0.2.2 起 CLICK 同目标由 repeat-click
  // 电路提前接管，无进展熔断改用 TYPE_TEXT 常量决策覆盖。）
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.questions?.ok) return { ok: true, status: 200, json: async () => noulResponse(1) };
    return { ok: true, status: 200, json: async () => opResponse('TYPE_TEXT', { confidence: 0.9, target: 2 }) };
  };
  const port = await freePort();
  const service = createBrowserBridgeService({ ports: [port], log: null, opTimeout: { default: 2000 } });
  const bridge = service.createClient({ taskId: 't-under-test' });
  const registered = {};
  hemiBrowser({ registerTool: (t) => { registered[t.name] = t; } }, { config: { ...ACT_CONFIG, permissionStatePath: permissionFile('full') }, bridge });
  await bridge.start();
  const dialed = dialExtension(port, {
    onCommand: (cmd) => {
      if (cmd.op === 'tab.snapshot') return { ok: true, data: SNAP_OK };
      if (cmd.op === 'tab.refAct') return { ok: true, data: { status: 'ok', label: '', id: '' } };
      return { ok: true, data: {} };
    },
  });
  try {
    const result = await registered.browser_act.execute('a3', { goal: '填出发地', successCriteria: '出发地为北京', typeText: '北京', maxSteps: 10 }, null);
    assert.equal(result.details.status, 'circuit-no-progress');
    assert.match(result.content[0].text, /没有进展/);
  } finally {
    globalThis.fetch = realFetch;
    await bridge.stop();
    await service.stopHub();
    await dialed;
  }

  // TYPE_TEXT 没有 typeText：明确报错，不含糊。
  const port2 = await freePort();
  const service2 = createBrowserBridgeService({ ports: [port2], log: null, opTimeout: { default: 2000 } });
  const bridge2 = service2.createClient({ taskId: 't-under-test-2' });
  const registered2 = {};
  const jev2 = fakeJev({ ops: [opResponse('TYPE_TEXT', { confidence: 0.9, target: 2 })] });
  hemiBrowser({ registerTool: (t) => { registered2[t.name] = t; } }, { config: { ...ACT_CONFIG, permissionStatePath: permissionFile('full') }, bridge: bridge2 });
  await bridge2.start();
  const dialed2 = dialExtension(port2, {
    onCommand: (cmd) => {
      if (cmd.op === 'tab.snapshot') return { ok: true, data: SNAP_OK };
      // 真实 SW 语义：type 动作缺 text 时返回 noText。
      if (cmd.op === 'tab.refAct') return { ok: true, data: { status: 'noText', label: '', id: '' } };
      return { ok: true, data: {} };
    },
  });
  try {
    const result = await registered2.browser_act.execute('a4', { goal: '填出发地', successCriteria: '出发地为北京' }, null);
    assert.equal(result.details.status, 'error');
    assert.match(result.content[0].text, /typeText/);
  } finally {
    jev2.restore();
    await bridge2.stop();
    await service2.stopHub();
    await dialed2;
  }
});

test('browser_act：开关或 key 缺一不可（免 key 不上场）', () => {
  let registered = [];
  const register = (t) => registered.push(t.name);
  hemiBrowser({ registerTool: register }, { config: { enabled: true, act: true, jev: {} } });
  assert.ok(!registered.includes('browser_act'), '无 key 不应注册');

  registered = [];
  hemiBrowser({ registerTool: register }, { config: { enabled: true, act: false, jev: { apiKey: 'k' } } });
  assert.ok(!registered.includes('browser_act'), '开关关不应注册');
});

test('真机扩展 service_worker.js / page-logic.js 语法自检（node --check）', () => {
  for (const file of [REAL_SW, REAL_PAGE_LOGIC]) {
    const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(res.status, 0, `${path.basename(file)} 语法错误：${res.stderr}`);
  }
});

test('browser_act：Jev 决策调用失败时 HTTP 状态与详情全量留痕（020 实录修复）', async () => {
  const port = await freePort();
  const service = createBrowserBridgeService({ ports: [port], log: null, opTimeout: { default: 2000 } });
  const bridge = service.createClient({ taskId: 't-under-test' });
  const registered = {};
  const detail = 'Authentication failed: model id "jev-test" is not available for this API key on this gateway (request id: req_trace_020_abcdefghijklmnopqrstuvwxyz)';
  const original = globalThis.fetch;
  let decideCalls = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.questions?.ok) return { ok: true, status: 200, json: async () => noulResponse(1) };
    decideCalls += 1;
    if (decideCalls === 1) return { ok: true, status: 200, json: async () => opResponse('WAIT', { confidence: 0.92 }) };
    return { ok: false, status: 401, json: async () => ({ error: { message: detail } }) };
  };
  hemiBrowser({ registerTool: (t) => { registered[t.name] = t; } }, { config: { ...ACT_CONFIG, permissionStatePath: permissionFile('full') }, bridge });
  await bridge.start();
  const dialed = dialExtension(port, {
    onCommand: (cmd) => (cmd.op === 'tab.snapshot' ? { ok: true, data: SNAP_OK } : { ok: true, data: {} }),
  });
  try {
    const result = await registered.browser_act.execute('a1', { goal: '等结果出现', successCriteria: '结果列表出现' }, null);
    assert.equal(result.details.status, 'error');
    assert.match(result.content[0].text, /决策端调用失败：Jev 调用失败 HTTP 401：/);
    // 旧代码 tail 截 160、steps 截 120——detail 全长 >150，两端都必须完整保留。
    assert.ok(result.content[0].text.includes(detail), '文本里的错误详情应完整（tail 300 字）');
    const step = result.details.steps.at(-1);
    assert.equal(step.op, 'DECIDE_ERROR');
    assert.ok(step.status.includes(detail), 'steps 计量里的错误详情应完整（300 字）');
    assert.equal(step.decideMs >= 0, true);
  } finally {
    globalThis.fetch = original;
    await bridge.stop();
    await service.stopHub();
    await dialed;
  }
});

test('browser_act：noul 核验调用失败要留痕，不与「判据不成立」混为一谈', async () => {
  const port = await freePort();
  const service = createBrowserBridgeService({ ports: [port], log: null, opTimeout: { default: 2000 } });
  const bridge = service.createClient({ taskId: 't-under-test' });
  const registered = {};
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.questions?.ok) return { ok: false, status: 400, json: async () => ({ error: { message: 'bad noul request' } }) };
    return { ok: true, status: 200, json: async () => opResponse('DONE', { confidence: 0.9 }) };
  };
  hemiBrowser({ registerTool: (t) => { registered[t.name] = t; } }, { config: { ...ACT_CONFIG, permissionStatePath: permissionFile('full') }, bridge });
  await bridge.start();
  const dialed = dialExtension(port, {
    onCommand: (cmd) => (cmd.op === 'tab.snapshot' ? { ok: true, data: SNAP_OK } : { ok: true, data: {} }),
  });
  try {
    const result = await registered.browser_act.execute('a1', { goal: '点查询', successCriteria: '结果出现' }, null);
    assert.equal(result.details.status, 'verify-failed');
    assert.match(result.content[0].text, /判据满足度=0/);
    assert.match(result.content[0].text, /核验调用失败：Jev 调用失败 HTTP 400：bad noul request/);
  } finally {
    globalThis.fetch = original;
    await bridge.stop();
    await service.stopHub();
    await dialed;
  }
});

// ---------- 021：地板豁免、双置信度、执行事实、指引两态、快照版本 ----------

/** 021 通用装配：env + 假 Jev + 假扩展，跑一次 browser_act。 */
async function runAct({ mode = 'full', ops = [], noul = [], onCommand, params } = {}) {
  const port = await freePort();
  const service = createBrowserBridgeService({ ports: [port], log: null, opTimeout: { default: 2000 } });
  const bridge = service.createClient({ taskId: 't-under-test' });
  const registered = {};
  const jev = fakeJev({ ops, noul });
  hemiBrowser({ registerTool: (t) => { registered[t.name] = t; } }, {
    config: { ...ACT_CONFIG, permissionStatePath: permissionFile(mode) },
    bridge,
  });
  await bridge.start();
  const dialed = dialExtension(port, {
    onCommand: onCommand ?? ((cmd) => (cmd.op === 'tab.snapshot' ? { ok: true, data: SNAP_OK } : { ok: true, data: { status: 'ok', label: '', id: '' } })),
  });
  const cleanup = async () => {
    jev.restore();
    await bridge.stop();
    await service.stopHub();
    await Promise.race([dialed, new Promise((r) => setTimeout(r, 800))]);
  };
  try {
    const result = await registered.browser_act.execute(
      'x1',
      { goal: params?.goal ?? '点查询', successCriteria: params?.criteria ?? '结果出现', ...params },
      null,
    );
    return { result, bridge, bodies: jev.bodies };
  } finally {
    await cleanup();
  }
}

test('021 AC-05：WAIT 低置信豁免地板线——观望不再计低置信熔断（task-1-mubanvq7 裁决）', async () => {
  // 连续 WAIT、置信 0.38（低于 0.4 地板）：旧代码会熔 circuit-low-confidence；
  // 新代码 WAIT/滚动豁免地板——照常观望，直到 waitRun 熔断（无进展的另一条线）。
  const { result } = await runAct({
    mode: 'full',
    ops: [
      opResponse('WAIT', { confidence: 0.38 }),
      opResponse('WAIT', { confidence: 0.38 }),
      opResponse('WAIT', { confidence: 0.38 }),
      opResponse('WAIT', { confidence: 0.38 }),
    ],
  });
  assert.equal(result.details.status, 'circuit-wait', 'WAIT 低置信应继续观望到 wait 熔断，而不是低置信熔断');
  assert.notEqual(result.details.status, 'circuit-low-confidence');
  assert.equal(result.details.reason, 'wait-timeout');
  const waitSteps = result.details.steps.filter((s) => s.op === 'WAIT');
  assert.equal(waitSteps.length, 3, '三次 WAIT 后熔断');
  assert.ok(waitSteps.every((s) => s.confidence === 0.38), '低置信观望如实记账');
});

test('021 AC-05：目标置信度缺失的副作用动作不直通，三次后熔断', async () => {
  // 操作 0.99，但目标答案不带 confidence → 无执行资格（review 基线 P1 反向）。
  const { result } = await runAct({
    mode: 'full',
    ops: [
      { model: 'jev-test', answers: { operation: { choice: 'CLICK', confidence: 0.99 }, click_target: { choice: '3' } } },
      { model: 'jev-test', answers: { operation: { choice: 'CLICK', confidence: 0.99 }, click_target: { choice: '3' } } },
      { model: 'jev-test', answers: { operation: { choice: 'CLICK', confidence: 0.99 }, click_target: { choice: '3' } } },
      { model: 'jev-test', answers: { operation: { choice: 'CLICK', confidence: 0.99 }, click_target: { choice: '3' } } },
    ],
    onCommand: (cmd) => {
      if (cmd.op === 'tab.snapshot') return { ok: true, data: { ...SNAP_OK, digest: `d${Math.random()}` } };
      if (cmd.op === 'tab.refAct') return { ok: true, data: { status: 'ok', label: '', id: '' } };
      return { ok: true, data: {} };
    },
  });
  assert.equal(result.details.status, 'circuit-low-confidence');
  assert.equal(result.details.reason, 'invalid-confidence');
  assert.match(result.content[0].text, /缺少合法置信度/);
  assert.ok(result.details.steps.every((s) => s.op === 'CLICK' && s.status === 'invalid-confidence'), '全程未执行任何动作');
  assert.equal(result.details.actionState, 'not-executed');
});

test('021 AC-05：WAIT 豁免不外溢——CLICK 低于地板仍然熔断', async () => {
  const { result } = await runAct({
    mode: 'full',
    ops: [
      opResponse('CLICK', { confidence: 0.2, target: 3 }),
      opResponse('CLICK', { confidence: 0.2, target: 3 }),
      opResponse('CLICK', { confidence: 0.2, target: 3 }),
      opResponse('CLICK', { confidence: 0.2, target: 3 }),
    ],
    onCommand: (cmd) => {
      if (cmd.op === 'tab.snapshot') return { ok: true, data: { ...SNAP_OK, digest: `d${Math.random()}` } };
      return { ok: true, data: {} };
    },
  });
  assert.equal(result.details.status, 'circuit-low-confidence');
  assert.equal(result.details.reason, 'low-confidence');
  assert.equal(result.details.actionState, 'not-executed', '副作用操作不受豁免');
});

test('021 AC-09：动作已发出但回执丢失 → dispatched-unknown，先核实不重发', async () => {
  const refActs = [];
  const { result } = await runAct({
    mode: 'full',
    ops: [
      opResponse('CLICK', { confidence: 0.9, target: 3 }),
      opResponse('CLICK', { confidence: 0.9, target: 3 }),
    ],
    onCommand: (cmd) => {
      if (cmd.op === 'tab.snapshot') return { ok: true, data: { ...SNAP_OK, digest: `d${Math.random()}` } };
      if (cmd.op === 'tab.refAct') {
        refActs.push(cmd.params);
        if (refActs.length === 1) return { ok: true, data: { status: 'ok', label: '', id: '' } };
        return { ok: false, error: '浏览器操作超时（15s）：tab.refAct' }; // 回执丢失
      }
      return { ok: true, data: {} };
    },
  });
  assert.equal(result.details.status, 'error');
  assert.equal(result.details.reason, 'unknown-receipt');
  assert.equal(result.details.actionState, 'dispatched-unknown', '回执丢失≠未执行');
  assert.match(result.content[0].text, /只读核实/);
  assert.match(result.content[0].text, /不要直接重复提交/);
  assert.equal(refActs.length, 2, '失败后不得自动重发');
});

test('021 R-09：先执行成功后引用失效熔断 → partially-executed，不再是 not-executed', async () => {
  const refActs = [];
  const { result } = await runAct({
    mode: 'full',
    ops: Array.from({ length: 5 }, () => opResponse('CLICK', { confidence: 0.9, target: 3 })),
    onCommand: (cmd) => {
      if (cmd.op === 'tab.snapshot') return { ok: true, data: { ...SNAP_OK, digest: `d${Math.random()}` } };
      if (cmd.op === 'tab.refAct') {
        refActs.push(cmd.params);
        return { ok: true, data: refActs.length === 1 ? { status: 'ok', label: '', id: '' } : { status: 'stale', label: '', id: '' } };
      }
      return { ok: true, data: {} };
    },
  });
  assert.equal(result.details.status, 'error');
  assert.equal(result.details.reason, 'stale-ref');
  assert.equal(result.details.executedEffects, 1, '第一步真实执行成功的事实保留');
  assert.equal(result.details.actionState, 'partially-executed', '已执行后失败不能谎报未执行');
});

test('021 R-10：无进展熔断在下一次副作用【前】触发，重复 TYPE_TEXT 只发三次', async () => {
  // 0.2.2 起 CLICK 同目标重复由 repeat-click 电路接管（更早停），无进展熔断
  // 对「换着花样也原地踏步」的形态兜底——这里用 TYPE_TEXT 常量决策覆盖。
  const refActs = [];
  const { result } = await runAct({
    mode: 'full',
    params: { typeText: '北京' },
    ops: Array.from({ length: 8 }, () => opResponse('TYPE_TEXT', { confidence: 0.9, target: 2 })),
    onCommand: (cmd) => {
      if (cmd.op === 'tab.snapshot') return { ok: true, data: SNAP_OK }; // 页面纹丝不动
      if (cmd.op === 'tab.refAct') { refActs.push(cmd.params); return { ok: true, data: { status: 'ok', label: '', id: '' } }; }
      return { ok: true, data: {} };
    },
  });
  assert.equal(result.details.status, 'circuit-no-progress');
  assert.equal(refActs.length, 3, '第 4 次同形决策派发前就停');
  assert.equal(result.details.reason, 'no-progress');
});

test('0.2.2 复盘：同一元素 CLICK 且页面无变化，第 2 次派发【前】停段（circuit-repeat-click）', async () => {
  // 真机实录（task-1-mucq6hjn）：同一排序项连点 5 次、搜索键连点 3 次，页面
  // 摘要一字未变——决策端无记忆，不拦会一直点到核验轮次耗尽。
  const refActs = [];
  const { result, bodies } = await runAct({
    mode: 'full',
    ops: Array.from({ length: 5 }, () => opResponse('CLICK', { confidence: 0.9, target: 3 })),
    onCommand: (cmd) => {
      if (cmd.op === 'tab.snapshot') return { ok: true, data: SNAP_OK };
      if (cmd.op === 'tab.refAct') { refActs.push(cmd.params); return { ok: true, data: { status: 'ok', label: '', id: '' } }; }
      return { ok: true, data: {} };
    },
  });
  assert.equal(result.details.status, 'circuit-repeat-click');
  assert.equal(result.details.reason, 'repeat-click');
  assert.equal(refActs.length, 1, '只有第一次点击真正派发');
  assert.equal(result.details.actionState, 'partially-executed', '已执行 1 次，执行事实如实');
  assert.match(result.content[0].text, /疑似开关型或无效控件/);
  assert.match(result.content[0].text, /browser_navigate 直达/, '停手指引指向换路而不是重试');
  // 决策端 state 里有「最近操作」摘要：无记忆的模型能看见自己刚点过什么。
  assert.match(bodies[1].state, /最近操作（从旧到新[^\n]*）：CLICK .+ → 已执行/);
});

test('0.2.2 复盘：verifyRounds 随终态入档——每轮核验的稳定性与判据分数可归因', async () => {
  const { result } = await runAct({
    mode: 'full',
    // DONE→核验不过→换目标 CLICK→DONE→再不过→再换→DONE：三轮耗尽 verify-failed。
    ops: [
      opResponse('DONE', { confidence: 0.9 }),
      opResponse('CLICK', { confidence: 0.9, target: 3 }),
      opResponse('DONE', { confidence: 0.9 }),
      opResponse('CLICK', { confidence: 0.9, target: 1 }),
      opResponse('DONE', { confidence: 0.9 }),
    ],
    noul: [noulResponse(0.3), noulResponse(0.3), noulResponse(0.3)],
    onCommand: (cmd) => {
      if (cmd.op === 'tab.snapshot') return { ok: true, data: SNAP_OK };
      if (cmd.op === 'tab.refAct') return { ok: true, data: { status: 'ok', label: '', id: '' } };
      return { ok: true, data: {} };
    },
  });
  assert.equal(result.details.status, 'verify-failed');
  assert.equal(result.details.verifyRounds.length, 3, '三轮核验全部留档');
  assert.ok(result.details.verifyRounds.every((v) => v.stable === true && v.satisfied === 0.3 && v.error === null));
});

test('021 AC-01/AC-02：指引两态——JEV 按适用性选择，不要求先失败再用 DOM', () => {
  {
    // 开：browser_act 注册，导航指引含首选，click/type 标兜底。
    const on = {};
    hemiBrowser({ registerTool: (t) => { on[t.name] = t; } }, { config: { enabled: true, act: true, jev: { apiKey: 'k' } } });
    assert.ok(on.browser_act, '开关+key 齐备应注册 browser_act');
    const navGuide = on.browser_navigate.promptGuidelines.join('\n');
    assert.match(navGuide, /按适用性选择 browser_act/);
    assert.doesNotMatch(navGuide, /首选 browser_act/);
    assert.match(navGuide, /browser_type\/browser_click/);
    assert.match(on.browser_act.promptSnippet, /可选/);
    assert.doesNotMatch([on.browser_click.promptSnippet, on.browser_type.promptSnippet].join(' '), /兜底|首选/);
    assert.match(on.browser_click.promptGuidelines.join('\n'), /已知 DOM 选择器/);
    assert.match(on.browser_type.promptGuidelines.join('\n'), /已知 DOM 选择器/);
    assert.match(on.browser_click.promptGuidelines.join('\n'), /无需先调用 browser_act/);

    // 关：不注册 browser_act；指引不得残留首选话术，也不得引用不存在的工具。
    const off = {};
    hemiBrowser({ registerTool: (t) => { off[t.name] = t; } }, { config: { enabled: true, act: false } });
    assert.ok(!off.browser_act, '关闭后不应注册 browser_act');
    const offNav = off.browser_navigate.promptGuidelines.join('\n');
    assert.ok(!offNav.includes('browser_act'), '关闭后不应出现 browser_act 字样');
    assert.match(offNav, /browser_type\/browser_click（DOM 选择器定位）/, '关闭时只提原工具');
    assert.equal(off.browser_click.promptGuidelines.join('\n').includes('兜底'), false, '无 JEV 时 click 不是兜底');
  }
});

test('021：旧扩展快照（无 v2 协议）显性报错，指引重载扩展', async () => {
  await assert.rejects(
    runAct({
      mode: 'full',
      ops: [opResponse('DONE', { confidence: 0.9 })],
      onCommand: (cmd) => (cmd.op === 'tab.snapshot'
        ? { ok: true, data: { title: '旧', url: 'https://x/', lines: [], click: [], type: [], select: [], refs: 0 } }
        : { ok: true, data: {} }),
    }),
    /重新加载/,
    '无 v2 协议的旧扩展应直接报错并指引重载',
  );
});

// ---------- 021：扩展版本上报（用户裁决：改完没版本号，分不清新旧） ----------

test('021 extVersion：hello 不带版本＝旧扩展，桥记 null 并如实落盘', async () => {
  // ① 旧扩展分支：hello 不带 extVersion → 桥记 null，状态文件如实落盘。
  const port = await freePort();
  const writes = [];
  const service = createBrowserBridgeService({
    ports: [port],
    log: null,
    statePath: '/tmp/hemi-bridge-state-test.json',
    writeFileFn: async (_path, data) => writes.push(JSON.parse(data)),
    opTimeout: { default: 2000 },
  });
  const bridge = service.createClient({ taskId: 't-under-test' });
  const registered = {};
  hemiBrowser({ registerTool: (t) => { registered[t.name] = t; } }, { config: { enabled: true }, bridge });
  await bridge.start();
  const dialed = dialExtension(port, { onCommand: () => ({ ok: true, data: {} }) });
  try {
    await bridge.waitReady(8000);
    assert.equal(bridge.extVersion, null, 'hello 未带版本 → null（旧扩展）');
    assert.equal(writes.at(-1)?.extVersion, null, '状态文件如实记录旧扩展');
  } finally {
    await bridge.stop();
    await service.stopHub();
    await Promise.race([dialed, new Promise((r) => setTimeout(r, 800))]);
  }
  // 新扩展分支（hello 带 extVersion 的记录与落盘）由 browser-bridge-service.test 的
  // 状态文件用例覆盖；ext.version 探针生产无调用方，不再单独验证透传。
});

// ---------- 022 真机：并行任务的桥报忙（扩展只连一个桥，后到任务须快速失败） ----------

test('022 detectOtherHubs：指纹识别别的 Hemi 桥，排除自身端口，无视随机服务', async () => {
  const { detectOtherHubs } = await import('./pi-browser.mjs');
  const { BrowserWsHub } = await import('./browser-ws.mjs');
  const portA = await freePort();
  const hubA = new BrowserWsHub({ log: null });
  await hubA.listen({ ports: [portA] });
  try {
    const found = await detectOtherHubs({ ports: [portA, await freePort()], excludePort: null, probeMs: 600 });
    assert.deepEqual(found, [portA], 'Hemi 桥应被指纹识别');

    const excluded = await detectOtherHubs({ ports: [portA], excludePort: portA, probeMs: 600 });
    assert.deepEqual(excluded, [], '排除自身端口后不应报占用');

    const { createServer } = await import('node:http');
    const plain = await freePort();
    const srv = createServer((_req, res) => { res.writeHead(200); res.end('hello'); });
    await new Promise((r) => srv.listen(plain, '127.0.0.1', r));
    try {
      const mixed = await detectOtherHubs({ ports: [plain], excludePort: null, probeMs: 600 });
      assert.deepEqual(mixed, [], '普通 HTTP 服务不应被认成桥');
    } finally {
      srv.close();
    }
  } finally {
    hubA.close();
  }
});

test('022 waitReady 超时且检测到别的桥：报忙文案指向「另一个任务占用」', async () => {
  const { BrowserWsHub } = await import('./browser-ws.mjs');
  const busyPort = await freePort();
  const hubA = new BrowserWsHub({ log: null });
  await hubA.listen({ ports: [busyPort] });
  try {
    // 生产同段现实：两个任务的桥都配置 9467-9470 同段。自己的桥绑到段内
    // 下一个空位（busyPort 被占），waitReady 超时后应在同段里探到 busyPort。
    const spare = await freePort();
    const service = createBrowserBridgeService({ ports: [busyPort, spare], log: null });
    const bridge = service.createClient({ taskId: 't-under-test' });
    await bridge.start();
    try {
      await assert.rejects(
        bridge.waitReady(700),
        /被另一个任务使用/,
        '等不到扩展且探到别的桥 → 报忙',
      );
    } finally {
      await bridge.stop();
      await service.stopHub();
    }
  } finally {
    hubA.close();
  }
});

test('021 R-08：DONE 核验前先等网络安静（tab.netQuiet），不拍空骨架', async () => {
  const netQuietCalls = [];
  const { result } = await runAct({
    mode: 'full',
    ops: [opResponse('CLICK', { confidence: 0.9, target: 3 }), opResponse('DONE', { confidence: 0.9 })],
    noul: [noulResponse(0.95)],
    onCommand: (cmd) => {
      if (cmd.op === 'tab.netQuiet') {
        netQuietCalls.push(cmd.params);
        return { ok: true, data: { quiet: true, waitedMs: 5 } };
      }
      if (cmd.op === 'tab.snapshot') return { ok: true, data: SNAP_OK };
      if (cmd.op === 'tab.refAct') return { ok: true, data: { status: 'ok', label: '', id: '' } };
      return { ok: true, data: {} };
    },
    params: { goal: '点查询', criteria: '结果出现' },
  });
  assert.equal(result.details.status, 'done');
  assert.deepEqual(
    netQuietCalls,
    [{ quietMs: 600, maxMs: 6000 }],
    'DONE 判定后应先等网络安静再做稳定性轮询',
  );
});

test('021 netQuiet 超上限返回 quiet:false 时核验照常兜底（不挂起）', async () => {
  const { result } = await runAct({
    mode: 'full',
    ops: [opResponse('DONE', { confidence: 0.9 })],
    noul: [noulResponse(0.95)],
    onCommand: (cmd) => {
      if (cmd.op === 'tab.netQuiet') return { ok: true, data: { quiet: false, waitedMs: 6000 } };
      if (cmd.op === 'tab.snapshot') return { ok: true, data: SNAP_OK };
      return { ok: true, data: {} };
    },
    params: { goal: '等结果', criteria: '结果出现' },
  });
  assert.equal(result.details.status, 'done', '网络不安静也要按快照稳定+noul 兜底收口');
});

test('进程内浏览器工具不注册退出／信号钩子，清理交给宿主回合', () => {
  const names = ['exit', 'SIGINT', 'SIGTERM'];
  const before = names.map(name => process.listenerCount(name));
  hemiBrowser({ registerTool() {} }, { config: { enabled: true }, bridge: {} });
  assert.deepEqual(names.map(name => process.listenerCount(name)), before);
});
