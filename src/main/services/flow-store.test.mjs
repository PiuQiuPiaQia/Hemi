// 057 flow-store 异步串行写入器单测（S2）：字段合并不互相覆盖、同会话串行、
// 失败重试不回滚内存、drop 排空后无迟到写入、loadFlow 版本护栏。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFlowStore } from './flow-store.mjs';

const settle = async (n = 3) => {
  for (let i = 0; i < n; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hemi-flow-store-'));
}

test('saveFlow：字段合并落盘，turns 等其他字段不被覆盖', async () => {
  const dir = tmpDir();
  const store = createFlowStore({ dir });
  // 预置一份带 turns 的会话档案（模拟 conversation-store 产物）。
  fs.writeFileSync(path.join(dir, 'conv-a.json'), JSON.stringify({ id: 'conv-a', turns: [{ role: 'user', text: 'hi' }], customTitle: '旧标题' }));
  await store.saveFlow('conv-a', { schemaVersion: 1, conversationId: 'conv-a', revision: 3 });
  await store.flush('conv-a');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'conv-a.json'), 'utf8'));
  assert.equal(saved.flow.revision, 3);
  assert.equal(saved.turns.length, 1, '其他字段保留');
  assert.equal(saved.customTitle, '旧标题');
  // 第二次更新：内存合并取最新 revision，旧快照不覆盖新字段。
  await store.saveFlow('conv-a', { schemaVersion: 1, conversationId: 'conv-a', revision: 4 });
  await store.saveFlow('conv-a', { schemaVersion: 1, conversationId: 'conv-a', revision: 5 });
  await store.flush('conv-a');
  const latest = JSON.parse(fs.readFileSync(path.join(dir, 'conv-a.json'), 'utf8'));
  assert.equal(latest.flow.revision, 5);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('同会话写入串行：无并发写同文件（临时文件唯一＋rename 原子）', async () => {
  const dir = tmpDir();
  const concurrent = [];
  let writing = 0;
  let maxConcurrent = 0;
  const store = createFlowStore({
    dir,
    fsOps: {
      mkdir: async (p) => { fs.mkdirSync(p, { recursive: true }); },
      readFile: async (p) => fs.readFileSync(p, 'utf8'),
      writeFile: async (p, data) => {
        writing += 1; maxConcurrent = Math.max(maxConcurrent, writing);
        await new Promise((r) => setTimeout(r, 5));
        fs.writeFileSync(p, data, 'utf8');
        writing -= 1;
      },
      rename: async (a, b) => { fs.renameSync(a, b); },
      unlink: async (p) => { fs.rmSync(p, { force: true }); },
    },
  });
  for (let i = 1; i <= 6; i += 1) {
    concurrent.push(store.saveFlow('conv-b', { schemaVersion: 1, conversationId: 'conv-b', revision: i }));
  }
  await Promise.all(concurrent);
  await store.flush('conv-b');
  assert.equal(maxConcurrent, 1, '同会话写串行');
  const final = JSON.parse(fs.readFileSync(path.join(dir, 'conv-b.json'), 'utf8'));
  assert.equal(final.flow.revision, 6);
  const leftovers = fs.readdirSync(dir).filter((name) => name.includes('.flowtmp-'));
  assert.deepEqual(leftovers, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('写入失败：内存事实保留、标脏重试于下一次 update/flush；不静默丢', async () => {
  const dir = tmpDir();
  let failWrites = 1;
  const store = createFlowStore({
    dir,
    fsOps: {
      mkdir: async (p) => { fs.mkdirSync(p, { recursive: true }); },
      readFile: async (p) => fs.readFileSync(p, 'utf8'),
      writeFile: async (p, data) => {
        if (failWrites > 0) { failWrites -= 1; throw new Error('disk full'); }
        fs.writeFileSync(p, data, 'utf8');
      },
      rename: async (a, b) => { fs.renameSync(a, b); },
      unlink: async (p) => { fs.rmSync(p, { force: true }); },
    },
  });
  await assert.rejects(() => store.saveFlow('conv-c', { schemaVersion: 1, conversationId: 'conv-c', revision: 1 }));
  assert.equal(store.hasFailure('conv-c'), true);
  // 再写一次（磁盘恢复）：脏数据一并落盘，revision 取内存最新。
  await store.saveFlow('conv-c', { schemaVersion: 1, conversationId: 'conv-c', revision: 2 });
  const final = JSON.parse(fs.readFileSync(path.join(dir, 'conv-c.json'), 'utf8'));
  assert.equal(final.flow.revision, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadFlow：读回最近提交快照；更高 schema 版本只读报不支持', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'conv-d.json'), JSON.stringify({ id: 'conv-d', flow: { schemaVersion: 1, revision: 9 } }));
  const store = createFlowStore({ dir });
  const loaded = await store.loadFlow('conv-d');
  assert.equal(loaded.revision, 9);
  fs.writeFileSync(path.join(dir, 'conv-d.json'), JSON.stringify({ id: 'conv-d', flow: { schemaVersion: 2, revision: 10 } }));
  const store2 = createFlowStore({ dir });
  assert.deepEqual(await store2.loadFlow('conv-d'), { unsupported: true, schemaVersion: 2 });
  assert.equal(await createFlowStore({ dir }).loadFlow('conv-absent'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('drop：排空写链后清理内存；随后的脏标记不会复活档案', async () => {
  const dir = tmpDir();
  const store = createFlowStore({ dir });
  await store.saveFlow('conv-e', { schemaVersion: 1, conversationId: 'conv-e', revision: 1 });
  await store.drop('conv-e');
  await settle();
  // drop 后目录里没有残留临时文件；重新 update 会以空记录重建（调用方负责删档语义）。
  const leftovers = fs.readdirSync(dir).filter((name) => name.includes('.flowtmp-'));
  assert.deepEqual(leftovers, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('生产同步路径：flow 写入不会被微任务间隙插入的同步保存覆盖（真机回归）', async () => {
  const dir = tmpDir();
  // 生产实例（不注入 fsOps → 同步临界段）。
  const store = createFlowStore({ dir });
  await store.saveFlow('conv-race', { schemaVersion: 1, conversationId: 'conv-race', revision: 1 });
  await store.flush('conv-race');
  // 模拟 conversation-store 在 flow 写链排队的微任务间隙里同步写 turns/agentSession。
  const target = path.join(dir, 'conv-race.json');
  const flowSave = store.saveFlow('conv-race', { schemaVersion: 1, conversationId: 'conv-race', revision: 2 });
  const midSync = { ...JSON.parse(fs.readFileSync(target, 'utf8')), turns: [{ id: 't1', author: 'hemi', text: '同步保存的回合' }], agentSession: { header: null, entries: [] } };
  fs.writeFileSync(target, JSON.stringify(midSync, null, 2));
  await flowSave;
  await store.flush('conv-race');
  const final = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(final.flow.revision, 2, 'flow 更新落盘');
  assert.equal(final.turns.length, 1, '微任务间隙的同步保存不丢');
  assert.ok(final.agentSession, 'agentSession 不丢');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('注入异步路径同构：字段合并不丢（2026-10-16 AC-38 探针回归——applyQueue 未 await 异步 readCurrent，Promise 被展开后 flow 以外字段全丢）', async () => {
  const dir = tmpDir();
  const target = path.join(dir, 'conv-async.json');
  fs.writeFileSync(target, JSON.stringify({ id: 'conv-async', title: '旧标题', turns: [{ id: 'u1', author: 'user', text: 'hi' }] }));
  const store = createFlowStore({
    dir,
    fsOps: {
      mkdir: (p) => fs.mkdirSync(p, { recursive: true }),
      readFile: (p) => fs.readFileSync(p, 'utf8'),
      writeFile: (p, data) => fs.writeFileSync(p, data, 'utf8'),
      rename: (a, b) => fs.renameSync(a, b),
      unlink: (p) => { try { fs.unlinkSync(p) } catch { /* 不在 */ } },
    },
  });
  await store.saveFlow('conv-async', { schemaVersion: 1, conversationId: 'conv-async', revision: 1 });
  await store.flush('conv-async');
  const saved = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(saved.flow.revision, 1, 'flow 落盘');
  assert.equal(saved.title, '旧标题', '异步路径同样保留兄弟字段（同构承诺）');
  assert.equal(saved.turns.length, 1, 'turns 不被 {flow} 单字段覆盖');
  fs.rmSync(dir, { recursive: true, force: true });
});
