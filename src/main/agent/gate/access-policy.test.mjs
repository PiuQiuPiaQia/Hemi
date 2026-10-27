// 042 · access-policy 单测：四值判定定序、能力二值、verify 只读、未知工具拒绝。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { judgeAccess, VERDICT } from './access-policy.mjs';

const noApp = { ok: false, reasonCode: 'UNAUTHORIZED' };
const baseQ = {
  hardline: () => null,
  dangerous: () => null,
  deniedPath: () => null,
  isControlPath: () => false,
  scopeForPath: () => null,
  appScope: () => noApp,
  resolveAppBundle: () => null,
};

test('bash：普通命令 allow（文件边界由沙箱强制）；hardline 拒；危险级独立确认', () => {
  const q = {
    ...baseQ,
    hardline: (c) => (/sudo/.test(c) ? { hit: true, description: '提权' } : null),
    dangerous: (c) => (/rm -rf/.test(c) ? { hit: true, description: '递归删除' } : null),
  };
  assert.equal(judgeAccess({ tool: 'bash', input: { command: 'ls ~/docs' }, q }).verdict, VERDICT.allow);
  assert.equal(judgeAccess({ tool: 'bash', input: { command: 'sudo rm x' }, q }).verdict, VERDICT.deny);
  const risk = judgeAccess({ tool: 'bash', input: { command: 'rm -rf ~/tmp/x' }, q });
  assert.equal(risk.verdict, VERDICT.confirmAction);
  assert.equal(risk.reason, '递归删除');
});

test('bash：联网命令照常放行（054 R-02：「联网搜索」开关只管 web 工具注册，判定层无此分支）', () => {
  assert.equal(judgeAccess({ tool: 'bash', input: { command: 'curl -sI https://example.com' }, q: baseQ }).verdict, VERDICT.allow);
  assert.equal(judgeAccess({ tool: 'bash', input: { command: 'ssh -T git@github.com' }, q: baseQ }).verdict, VERDICT.allow);
});

test('bash：本机凭据读取硬拒（054 R-04）；ssh/git 自用不受影响', () => {
  const q = {
    ...baseQ,
    secretRead: (c) => (/id_rsa|id_ed25519|\.env\b|shadow/.test(c) ? { hit: true, description: 'SSH 私钥文件' } : null),
  };
  for (const command of ['cat ~/.ssh/id_rsa', 'cat ~/.ssh/id_ed25519', 'cat .env', 'head -5 /etc/shadow']) {
    const out = judgeAccess({ tool: 'bash', input: { command }, q });
    assert.equal(out.verdict, VERDICT.deny, command);
    assert.equal(out.reasonCode, 'SECRET_READ', command);
  }
  assert.equal(judgeAccess({ tool: 'bash', input: { command: 'ssh -T git@github.com' }, q }).verdict, VERDICT.allow);
  assert.equal(judgeAccess({ tool: 'bash', input: { command: 'git fetch origin' }, q }).verdict, VERDICT.allow);
});

test('文件（2026-10-15 只保留应用级授权）：本机与远端读写都完全访问，不再出文件夹授权卡；系统目录不可写', () => {
  const q = {
    ...baseQ,
    resolvePath: (raw) => ({ raw, real: raw }),
    systemWriteRoot: (p) => p === '/etc' || p.startsWith('/etc/'),
  };
  for (const remoteHost of [null, 'u@h']) {
    for (const tool of ['read', 'write', 'edit', 'ls', 'grep', 'glob']) {
      const out = judgeAccess({ tool, input: { path: '/elsewhere/a.txt' }, remoteHost, q });
      assert.equal(out.verdict, VERDICT.allow, `${remoteHost ?? '本机'} ${tool}`);
    }
    assert.equal(judgeAccess({ tool: 'read', input: { path: '/etc/hosts' }, remoteHost, q }).verdict, VERDICT.allow, '系统目录可读');
    const sysWrite = judgeAccess({ tool: 'write', input: { path: '/etc/hosts' }, remoteHost, q });
    assert.equal(sysWrite.verdict, VERDICT.deny);
    assert.equal(sysWrite.reasonCode, 'HARDLINE');
  }
});

test('文件：硬拒绝路径与控制面路径 deny', () => {
  const q = {
    ...baseQ,
    resolvePath: (raw) => ({ raw, real: raw }),
    deniedPath: (real) => (real.startsWith('/etc/') ? '禁止' : null),
    isControlPath: (real) => real.endsWith('access-grants.json'),
  };
  assert.equal(judgeAccess({ tool: 'read', input: { path: '/etc/passwd' }, q }).reasonCode, 'HARDLINE');
  assert.equal(judgeAccess({ tool: 'read', input: { path: '/ud/access-grants.json' }, q }).reasonCode, 'HARDLINE');
});

test('verify/closure：写类拒绝、危险拒绝；读取放行（不弹卡）', () => {
  const q = { ...baseQ, resolvePath: (raw) => ({ raw, real: raw }) };
  assert.equal(judgeAccess({ tool: 'write', input: { path: '/x' }, phase: 'verify', q }).reasonCode, 'READ_ONLY_PHASE');
  assert.equal(judgeAccess({ tool: 'memory_write', input: {}, phase: 'verify', q }).reasonCode, 'READ_ONLY_PHASE');
  assert.equal(judgeAccess({ tool: 'read', input: { path: '/nope' }, phase: 'verify', q }).verdict, VERDICT.allow, '本机核实照常可读');
  assert.equal(judgeAccess({ tool: 'read', input: { path: '/nope' }, phase: 'verify', remoteHost: 'u@h', q }).verdict, VERDICT.allow, '远端核实同样可读');
  const risk = judgeAccess({ tool: 'bash', input: { command: 'rm -rf /x' }, phase: 'verify',
    q: { ...q, dangerous: () => ({ hit: true, description: '删' }) } });
  assert.equal(risk.reasonCode, 'READ_ONLY_PHASE');
});

test('桌面：有归属无授权 → request_grant(app/access)；无法归属 → deny；screen_view 无目标 → deny', () => {
  const q = { ...baseQ, resolveAppBundle: () => ({ bundleId: 'com.tencent.xinWeChat', name: '微信' }) };
  const card = judgeAccess({ tool: 'ui_tree', input: { app: '微信' }, q });
  assert.equal(card.verdict, VERDICT.requestGrant);
  assert.equal(card.kind, 'app');
  assert.equal(judgeAccess({ tool: 'ui_tree', input: { app: '微信' }, q: { ...q, appScope: () => ({ ok: true }) } }).verdict, VERDICT.allow);
  assert.equal(judgeAccess({ tool: 'ui_click', input: {}, q: baseQ }).reasonCode, 'IDENTITY_UNKNOWN');
  assert.equal(judgeAccess({ tool: 'screen_view', input: {}, q }).reasonCode, 'IDENTITY_UNKNOWN');
});

test('ui_list 放行；浏览器/联网放行（功能开关由挂载控制）；未知工具拒绝', () => {
  assert.equal(judgeAccess({ tool: 'ui_list', input: {}, q: baseQ }).verdict, VERDICT.allow);
  assert.equal(judgeAccess({ tool: 'browser_navigate', input: { url: 'https://x' }, q: baseQ }).verdict, VERDICT.allow);
  assert.equal(judgeAccess({ tool: 'web_search', input: { query: 'x' }, q: baseQ }).verdict, VERDICT.allow);
  assert.equal(judgeAccess({ tool: 'some_plugin', input: {}, q: baseQ }).reasonCode, 'UNSUPPORTED_CHANNEL');
});

test('delivery：run 放行 / verify 拒', () => {
  assert.equal(judgeAccess({ tool: 'register_delivery', input: {}, q: baseQ }).verdict, VERDICT.allow);
  assert.equal(judgeAccess({ tool: 'register_delivery', input: {}, phase: 'closure', q: baseQ }).reasonCode, 'READ_ONLY_PHASE');
});

test('verify/收尾严格只读：bash 拒、桌面动作拒、浏览器读取（含 *_extract）放行', () => {
  const app = { bundleId: 'com.apple.Notes', name: '备忘录' };
  const q = { ...baseQ, resolveAppBundle: () => app, appScope: () => ({ ok: true }) };
  const v = (tool, input = {}) => judgeAccess({ tool, input, phase: 'verify', q }).verdict;
  assert.equal(v('bash', { command: 'ls' }), VERDICT.deny);
  for (const tool of ['ui_click', 'ui_type', 'ui_key', 'ui_scroll', 'ui_act']) assert.equal(v(tool, { target: { pid: 1 } }), VERDICT.deny, tool);
  assert.equal(v('ui_tree', { app: '备忘录' }), VERDICT.allow);
  assert.equal(v('browser_extract'), VERDICT.allow);
  assert.equal(v('web_extract'), VERDICT.allow);
  assert.equal(v('browser_click'), VERDICT.deny);
});

test('ls/grep/glob 缺省 path 按工作目录判定（不再一律拒）', () => {
  const q = { ...baseQ, resolvePath: (raw) => ({ raw, real: '/ws' }), scopeForPath: () => ({ kind: 'workspace', capability: 'edit' }) };
  assert.equal(judgeAccess({ tool: 'grep', input: { pattern: 'x' }, q }).verdict, VERDICT.allow);
  assert.equal(judgeAccess({ tool: 'read', input: {}, q }).verdict, VERDICT.deny);
});

test('Skill 租约：读放行；写硬拒不进编辑卡（2026-10-10 会话审计）', () => {
  const leased = '/ud/skills/versions/bazi_x/aa842809';
  const q = {
    ...baseQ,
    resolvePath: (raw) => ({ raw, real: raw }),
    isControlPath: (real) => real.startsWith('/ud/') && !real.startsWith(`${leased}/`) && real !== leased,
    scopeForPath: (p) => (p === leased || p.startsWith(`${leased}/`)
      ? { kind: 'skill-lease', capability: 'access' }
      : null),
  };
  assert.equal(judgeAccess({ tool: 'read', input: { path: `${leased}/references/wuxing-tables.md` }, q }).verdict, VERDICT.allow);
  assert.equal(judgeAccess({ tool: 'ls', input: { path: leased }, q }).verdict, VERDICT.allow);
  const w = judgeAccess({ tool: 'write', input: { path: `${leased}/SKILL.md` }, q });
  assert.equal(w.verdict, VERDICT.deny);
  assert.equal(w.reasonCode, 'HARDLINE');
  // verify 态读租约同样放行（skill 资源可当核验证据）。
  assert.equal(judgeAccess({ tool: 'read', input: { path: `${leased}/SKILL.md` }, phase: 'verify', q }).verdict, VERDICT.allow);
});

test('app_open：按目标应用授权判定（未授权弹应用卡），verify 拒', () => {
  const app = { bundleId: 'com.apple.calculator', name: '计算器' };
  const q = { ...baseQ, resolveAppBundle: () => app };
  const card = judgeAccess({ tool: 'app_open', input: { app: '计算器' }, q });
  assert.equal(card.verdict, VERDICT.requestGrant);
  assert.equal(card.kind, 'app');
  assert.equal(judgeAccess({ tool: 'app_open', input: { app: '计算器' }, q: { ...q, appScope: () => ({ ok: true }) } }).verdict, VERDICT.allow);
  assert.equal(judgeAccess({ tool: 'app_open', input: { app: '计算器' }, phase: 'verify', q: { ...q, appScope: () => ({ ok: true }) } }).verdict, VERDICT.deny);
  assert.equal(judgeAccess({ tool: 'app_open', input: { app: '不存在' }, q: baseQ }).verdict, VERDICT.deny);
});

test('056 只读边界（run＋boundary readonly）同样拒写记忆与登记交付；读记忆放行', () => {
  const q = { ...baseQ, resolvePath: (raw) => ({ raw, real: raw }) };
  const b = (tool) => judgeAccess({ tool, input: {}, boundary: 'readonly', q });
  assert.equal(b('memory_write').reasonCode, 'BOUNDARY_READONLY');
  assert.equal(b('memory_forget').reasonCode, 'BOUNDARY_READONLY');
  assert.equal(b('scratchpad').reasonCode, 'BOUNDARY_READONLY');
  assert.equal(b('register_delivery').reasonCode, 'BOUNDARY_READONLY');
  assert.equal(b('memory_read').verdict, VERDICT.allow);
  assert.equal(judgeAccess({ tool: 'memory_write', input: {}, q }).verdict, VERDICT.allow, '缺省边界照常');
});

test('受控引用读取在普通／只读角色和核验阶段均可到达执行层，不误判未知通道', () => {
  for (const tool of ['context_read', 'task_read']) {
    for (const options of [{}, { boundary: 'readonly' }, { phase: 'verify' }]) {
      const result = judgeAccess({ tool, input: { ref: 'ctx-placeholder', taskId: 'task-placeholder' }, q: baseQ, ...options });
      assert.equal(result.verdict, VERDICT.allow);
    }
  }
});
