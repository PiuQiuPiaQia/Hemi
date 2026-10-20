// 025 交付登记宿主侧单测：文件查证/范围收口/去重复用 ID/图片绑定。
// 真实 fs 走 mkdtemp 家目录注入；档案用内存 fake（只需 task-manager 依赖的几个方法）。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createArtifactPreviewReader,
  createDeliveryImageReader,
  createDeliveryRegistrar,
  normalizeRemotePath,
  remoteDeliveryDenied,
} from './register.mjs';
import { DELIVERY_LIMITS } from './delivery.mjs';

/** 内存档案 fake：记录 appendDeliverable/mergeDeliverableMeta/setDelivery 调用。 */
function fakeHistory(deliverables = []) {
  const calls = { appended: [], merged: [], setDelivery: [] };
  const history = {
    deliverables,
    calls,
    getRecord(taskId) {
      // 与真实档案同纪律：未知 taskId 查无记录。
      if (String(taskId) !== 'task-1') return null;
      return { deliverables: history.deliverables };
    },
    appendDeliverable(_taskId, artifact) {
      calls.appended.push(artifact);
      history.deliverables.push(artifact);
      return true;
    },
    mergeDeliverableMeta(_taskId, artifactId, meta) {
      calls.merged.push({ artifactId, meta });
      const hit = history.deliverables.find((item) => item.id === artifactId);
      if (hit) Object.assign(hit, meta);
      return true;
    },
    setDelivery(_taskId, delivery) {
      calls.setDelivery.push(delivery);
      return true;
    },
  };
  return history;
}

function makeHome() {
  return mkdtempSync(path.join(os.tmpdir(), 'hemi-delivery-'));
}

function basePayload(overrides = {}) {
  return {
    files: [{ path: 'out/result.csv', description: '整理后的对照表' }],
    sources: [],
    ...overrides,
  };
}

test('registerDelivery v2：家目录内文件查证登记，description 保留，不写 delivery', () => {
  const home = makeHome();
  try {
    mkdirSync(path.join(home, 'out'), { recursive: true });
    writeFileSync(path.join(home, 'out/result.csv'), 'a,b\n1,2\n');
    const history = fakeHistory();
    const registrar = createDeliveryRegistrar({ history, nextArtifactId: () => 'art-7', home });
    const task = { historyId: 'task-1', artifacts: [] };
    const result = registrar.registerDelivery(task, basePayload());
    assert.equal(result.ok, true);
    assert.equal(result.delivery.schemaVersion, 2);
    assert.equal(result.delivery.files.length, 1);
    assert.equal(result.delivery.files[0].id, 'art-7');
    // 产物进入任务 artifacts 与档案；路径是 realpath 后的绝对路径。
    assert.equal(task.artifacts.length, 1);
    assert.equal(task.artifacts[0].id, 'art-7');
    assert.equal(task.artifacts[0].description, '整理后的对照表');
    // 登记路径是 realpath 后的（macOS tmpdir 会带 /private 前缀）。
    assert.equal(task.artifacts[0].path, realpathSync(path.join(home, 'out/result.csv')));
    assert.equal(history.calls.appended.length, 1);
    assert.equal(history.calls.setDelivery.length, 0, '050：新任务不再写 v1 delivery');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('registerDelivery：重复登记同一路径复用原 ID 并合并 role', () => {
  const home = makeHome();
  try {
    mkdirSync(path.join(home, 'out'), { recursive: true });
    writeFileSync(path.join(home, 'out/result.csv'), 'a\n');
    // 已有条目按 realpath 后的路径存（与登记器写入一致）。
    const existing = {
      id: 'art-1',
      kind: 'file',
      path: realpathSync(path.join(home, 'out/result.csv')),
      name: 'result.csv',
    };
    const history = fakeHistory([existing]);
    const registrar = createDeliveryRegistrar({ history, nextArtifactId: () => 'art-8', home });
    const task = { historyId: 'task-1', artifacts: [] };
    const result = registrar.registerDelivery(task, basePayload());
    assert.equal(result.ok, true);
    assert.deepEqual(result.delivery.files.map((f) => f.id), ['art-1']); // 复用原 ID
    assert.deepEqual(history.calls.appended, []); // 不再新登记
    assert.equal(history.calls.merged.length, 1);
    assert.equal(history.calls.merged[0].artifactId, 'art-1');
    assert.equal(history.calls.merged[0].meta.description, '整理后的对照表');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('registerDelivery：家目录外/符号链接绕行/敏感路径一律降级拒绝', () => {
  const home = makeHome();
  const outside = makeHome();
  try {
    writeFileSync(path.join(outside, 'secret.txt'), 'x');
    mkdirSync(path.join(home, 'link'), { recursive: true });
    symlinkSync(path.join(outside, 'secret.txt'), path.join(home, 'link/escape.txt'));
    mkdirSync(path.join(home, '.ssh'), { recursive: true });
    writeFileSync(path.join(home, '.ssh/id_ed25519'), 'key');

    const history = fakeHistory();
    const registrar = createDeliveryRegistrar({ history, nextArtifactId: () => 'art-9', home });
    const result = registrar.registerDelivery(
      { historyId: 'task-1', artifacts: [] },
      basePayload({
        files: [
          { path: path.join(outside, 'secret.txt') },
          { path: path.join(home, 'link/escape.txt') },
          { path: path.join(home, '.ssh/id_ed25519') },
        ],
      }),
    );
    // 主文件全部不可用 → 整体拒绝（缺指定格式不能标记交付成功）。
    assert.equal(result.ok, false);
    assert.match(result.reason, /文件都不可用/);
    assert.deepEqual(history.calls.appended, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('registerDelivery：声明的文件不存在整体拒绝（可修正）；纯来源声明不受影响', () => {
  const home = makeHome();
  try {
    const history = fakeHistory();
    const registrar = createDeliveryRegistrar({ history, nextArtifactId: () => 'art-10', home });
    const task = { historyId: 'task-1', artifacts: [] };
    // 声明了文件但路径不存在：整体拒绝，理由可行动（R-04——让执行器修正路径）。
    const result = registrar.registerDelivery(task, basePayload({
      files: [{ path: 'ghost.csv' }],
      sources: [{ title: '参考', url: 'https://ref.example.com/a' }],
    }));
    assert.equal(result.ok, false);
    assert.match(result.reason, /文件都不可用/);
    assert.equal(task.artifacts.length, 0);
    // 纯来源声明（files 空＋sources 非空）：登记成立，来源形状透传。
    const only = registrar.registerDelivery(task, basePayload({
      files: [],
      sources: [{ title: '参考', url: 'https://ref.example.com/a' }],
    }));
    assert.equal(only.ok, true);
    assert.equal(only.delivery.sources.length, 1);
    assert.equal(only.delivery.files.length, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('registerDelivery：登记次数有上限，超出后拒绝', () => {
  const home = makeHome();
  try {
    const history = fakeHistory();
    const registrar = createDeliveryRegistrar({ history, nextArtifactId: () => 'art-11', home });
    const task = { historyId: 'task-1', artifacts: [] };
    for (let i = 0; i < DELIVERY_LIMITS.attempts; i += 1) {
      registrar.registerDelivery(task, basePayload({ files: [] })); // 拒绝也计入次数
    }
    const over = registrar.registerDelivery(task, basePayload());
    assert.equal(over.ok, false);
    assert.match(over.reason, /上限/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('readDeliveryImage：只认登记过的图片产物（扩展名与寻址受限）', async () => {
  const home = makeHome();
  try {
    mkdirSync(path.join(home, 'img'), { recursive: true });
    const imagePath = path.join(home, 'img/chart.png');
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(path.join(home, 'img/notes.txt'), 'hello');
    const reader = createDeliveryImageReader({
      history: fakeHistory([
        { id: 'art-a', kind: 'file', path: imagePath },
        { id: 'art-b', kind: 'file', path: path.join(home, 'img/notes.txt') },
        { id: 'art-c', kind: 'link', url: 'https://a.example.com' },
      ]),
    });
    const hit = await reader.readDeliveryImage('task-1', 'art-a');
    assert.equal(hit.ok, true);
    assert.match(hit.dataUrl, /^data:image\/png;base64,/);
    assert.equal((await reader.readDeliveryImage('task-1', 'art-b')).ok, false); // 扩展名不认
    assert.equal((await reader.readDeliveryImage('task-1', 'art-c')).ok, false); // link 不认
    assert.equal((await reader.readDeliveryImage('task-1', 'art-zz')).ok, false); // 未登记
    assert.equal((await reader.readDeliveryImage('task-404', 'art-a')).ok, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- 026 R-05/R-06：应用内文件预览的受控读取 ----
test('readArtifactPreview：Markdown/纯文本读为文本，图片读为 data URL', async () => {
  const home = makeHome();
  try {
    mkdirSync(path.join(home, 'docs'), { recursive: true });
    writeFileSync(path.join(home, 'docs/说明.md'), '# 标题\n\n正文。');
    writeFileSync(path.join(home, 'docs/notes.txt'), 'plain text');
    writeFileSync(path.join(home, 'docs/chart.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const reader = createArtifactPreviewReader({
      history: fakeHistory([
        { id: 'art-md', kind: 'file', path: path.join(home, 'docs/说明.md') },
        { id: 'art-txt', kind: 'file', path: path.join(home, 'docs/notes.txt') },
        { id: 'art-png', kind: 'file', path: path.join(home, 'docs/chart.png') },
      ]),
    });
    const md = await reader.readArtifactPreview('task-1', 'art-md');
    assert.equal(md.ok, true);
    assert.equal(md.kind, 'text');
    assert.equal(md.markdown, true);
    assert.match(md.text, /标题/);

    const txt = await reader.readArtifactPreview('task-1', 'art-txt');
    assert.equal(txt.kind, 'text');
    assert.equal(txt.markdown, false);

    const png = await reader.readArtifactPreview('task-1', 'art-png');
    assert.equal(png.ok, true);
    assert.equal(png.kind, 'image');
    assert.match(png.dataUrl, /^data:image\/png;base64,/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('readArtifactPreview：未支持格式/未登记/档案缺失返回可展示原因', async () => {
  const home = makeHome();
  try {
    writeFileSync(path.join(home, 'table.csv'), 'a,b');
    const reader = createArtifactPreviewReader({
      history: fakeHistory([
        { id: 'art-csv', kind: 'file', path: path.join(home, 'table.csv') },
      ]),
    });
    const csv = await reader.readArtifactPreview('task-1', 'art-csv');
    assert.equal(csv.ok, false);
    assert.match(csv.message, /暂不支持/);
    assert.equal((await reader.readArtifactPreview('task-1', 'art-none')).ok, false);
    assert.equal((await reader.readArtifactPreview('task-404', 'art-csv')).ok, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('readArtifactPreview：文件被移走后原位报原因（可重试），不抛错', async () => {
  const home = makeHome();
  try {
    const missing = path.join(home, 'gone.md');
    writeFileSync(missing, 'x');
    const reader = createArtifactPreviewReader({
      history: fakeHistory([{ id: 'art-gone', kind: 'file', path: missing }]),
    });
    rmSync(missing);
    const result = await reader.readArtifactPreview('task-1', 'art-gone');
    assert.equal(result.ok, false);
    // ENOENT 必须给出「不在原位置」的可行动原因（2026-09-28 真机走查发现
    // 曾落到笼统的「读取失败」——statSync 抛错绕过了 isFile 分支）。
    assert.match(result.message, /不在原位置|移动|删除/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- 033 工作区：登记边界扩到任务工作目录（外接盘项目可登记） ----

test('033 registerDelivery：任务工作目录内（家目录外）可登记；相对路径按工作目录', () => {
  const home = makeHome();
  const ws = mkdtempSync(path.join(os.tmpdir(), 'hemi-ws-external-'));
  try {
    mkdirSync(path.join(ws, 'out'), { recursive: true });
    writeFileSync(path.join(ws, 'out', 'report.md'), '# 结果\n');
    const history = fakeHistory();
    const registrar = createDeliveryRegistrar({ history, nextArtifactId: () => 'art-w1', home });
    const task = { historyId: 'task-1', artifacts: [] };
    // 绝对路径（家目录外、工作目录内）。
    let result = registrar.registerDelivery(task, basePayload({ files: [{ path: path.join(ws, 'out', 'report.md') }] }), { workspaceDir: ws });
    assert.equal(result.ok, true);
    assert.equal(task.artifacts[0].path, realpathSync(path.join(ws, 'out', 'report.md')));
    // 相对路径按任务工作目录解析：解析到同一真实文件 → 复用原 ID（去重口径）。
    const task2 = { historyId: 'task-1', artifacts: [] };
    result = registrar.registerDelivery(task2, basePayload({ files: [{ path: 'out/report.md' }] }), { workspaceDir: ws });
    assert.equal(result.ok, true);
    assert.deepEqual(result.delivery.files.map((f) => f.id), ['art-w1']);
    assert.equal(task2.artifacts.length, 0, '同路径重复登记复用档案条目，不重复入任务表');
    // 不带 workspaceDir（旧任务语义）：家目录外的文件声明整体拒绝。
    const task3 = { historyId: 'task-1', artifacts: [] };
    result = registrar.registerDelivery(task3, basePayload({ files: [{ path: path.join(ws, 'other', 'x.md') }] }), { workspaceDir: null });
    assert.equal(result.ok, false);
    assert.match(result.reason, /家目录与工作目录之外|文件都不可用/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});

test('033 registerDelivery：工作目录也拦系统根区与敏感位置（链接绕行仍现形）', () => {
  const home = makeHome();
  const ws = mkdtempSync(path.join(os.tmpdir(), 'hemi-ws-deny-'));
  try {
    const history = fakeHistory();
    const registrar = createDeliveryRegistrar({ history, nextArtifactId: () => 'art-w2', home });
    // 符号链接从家目录指向系统敏感位置（/etc）：realpath 现形后拒绝登记。
    const escape = path.join(home, 'escape-link');
    symlinkSync('/etc/hosts', escape);
    const task = { historyId: 'task-1', artifacts: [] };
    const result = registrar.registerDelivery(task, basePayload({ files: [{ path: escape }] }), { workspaceDir: ws });
    assert.equal(result.ok, false);
    assert.match(result.reason, /敏感位置|文件都不可用|之外/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});

// ---- 049 · 远端交付（remote 模式：查证映射进、产物带 host、不触本机） ----

test('049 registerDelivery：远端模式按预查证映射登记，产物带 host；本机同名诱饵不被读', { skip: process.platform === 'win32' ? '诱饵构造要求本机路径与远端 POSIX 路径同串：win 盘符路径永远不是合法远端路径' : false }, () => {
  const home = makeHome();
  try {
    // 本机诱饵：与远端路径同名的文件（若实现误读本机会“查证通过”）。
    const decoyDir = path.join(home, 'decoy');
    mkdirSync(decoyDir, { recursive: true });
    writeFileSync(path.join(decoyDir, 'report.md'), '本机诱饵内容');
    const remotePath = path.join(decoyDir, 'report.md');

    const history = fakeHistory();
    const registrar = createDeliveryRegistrar({ history, nextArtifactId: () => 'art-r1', home });
    const task = { historyId: 'task-1', artifacts: [] };
    const verified = new Map([
      [remotePath, { ok: true, target: remotePath, size: 12 }],
    ]);
    const result = registrar.registerDelivery(
      task,
      basePayload({ files: [{ path: remotePath, description: '远端报告' }] }),
      { remote: { host: 'devbox', home: '/home/u', dir: '/home/u/proj', verified } },
    );
    assert.equal(result.ok, true);
    assert.equal(result.delivery.files.length, 1);
    const artifact = history.getRecord('task-1').deliverables[0];
    assert.equal(artifact.host, 'devbox');
    assert.equal(artifact.path, remotePath);
    assert.equal(artifact.description, '远端报告');
    // 查证映射里没有的路径 → 整体不成立（不读本机、不猜）。
    const miss = registrar.registerDelivery(
      { historyId: 'task-1', artifacts: [], deliveryAttempts: 0 },
      basePayload({ files: [{ path: '/home/u/proj/missing.txt' }] }),
      { remote: { host: 'devbox', home: '/home/u', dir: '/home/u/proj', verified: new Map() } },
    );
    assert.equal(miss.ok, false);
    assert.match(miss.reason, /文件都不可用/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('049 normalizeRemotePath / remoteDeliveryDenied：~/相对归一与敏感位判定', () => {
  assert.equal(normalizeRemotePath('~/projects/atlas/out/a.md', { home: '/home/u', dir: '/home/u/proj' }), '/home/u/projects/atlas/out/a.md');
  assert.equal(normalizeRemotePath('out/a.md', { home: '/home/u', dir: '/home/u/proj' }), '/home/u/proj/out/a.md');
  assert.equal(normalizeRemotePath('/srv/x', { home: '/home/u', dir: '/home/u/proj' }), '/srv/x');
  assert.equal(remoteDeliveryDenied('/home/u/.ssh/config', { home: '/home/u' }), true);
  assert.equal(remoteDeliveryDenied('/home/u/.env', { home: '/home/u' }), true);
  assert.equal(remoteDeliveryDenied('/home/u/proj/.env', { home: '/home/u' }), false); // 嵌套深度与本机口径一致：只拦家内首段
  assert.equal(remoteDeliveryDenied('/home/u/proj/out/a.md', { home: '/home/u' }), false);
  assert.equal(remoteDeliveryDenied('/etc/passwd', { home: '/home/u' }), true);
  assert.equal(remoteDeliveryDenied('/srv/www/index.html', { home: '/home/u' }), true);
  assert.equal(remoteDeliveryDenied('/opt/tool/bin/x', { home: '/home/u' }), true);
});
