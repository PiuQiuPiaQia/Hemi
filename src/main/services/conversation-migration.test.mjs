// 057 v2 迁移单测：幂等、备份先行、损坏/高版本不覆盖、flow 保留已有。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConversationStore, CONVERSATION_VERSION } from '../history/conversation-store.mjs';
import { migrateConversationDirToV2, repairConversationFlowHistory } from './conversation-migration.mjs';
import { createFlowSnapshot } from '../../shared/conversation-flow.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hemi-mig-'));
}

const V1 = {
  id: 'conv-a', createdAt: 1, updatedAt: 2, version: 1,
  turns: [
    { id: 'u1', createdAt: 10, author: 'user', text: '问' },
    { id: 'h1', createdAt: 11, author: 'hemi', text: '答' },
  ],
};

test('v2 迁移：备份先行、flow 落档、幂等、损坏不动', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'conv-a.json'), JSON.stringify(V1, null, 2));
  fs.writeFileSync(path.join(dir, 'conv-bad.json'), '{oops');
  const report = migrateConversationDirToV2(dir);
  assert.equal(report.migrated, 1);
  assert.equal(report.backups, 1);
  assert.equal(report.skippedCorrupt, 1);
  const migrated = JSON.parse(fs.readFileSync(path.join(dir, 'conv-a.json'), 'utf8'));
  assert.equal(migrated.version, 2);
  assert.equal(migrated.flow.conversationId, 'conv-a');
  assert.equal(migrated.flow.timeline.length, 2);
  assert.equal(migrated.turns.length, 2, 'turns 保留作载荷');
  assert.ok(fs.existsSync(path.join(dir, 'conv-a.migration-v1.json')), '备份在场');
  // 幂等：再跑不动（已有 flow/v2）。
  const again = migrateConversationDirToV2(dir);
  assert.equal(again.migrated, 0);
  assert.equal(again.backups, 0);
  assert.equal(String(fs.readFileSync(path.join(dir, 'conv-bad.json'))), '{oops', '损坏不覆盖');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('已有 flow / 更高版本跳过；v2 常量同步', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'conv-flow.json'), JSON.stringify({ ...V1, id: 'conv-flow', version: 2, flow: { schemaVersion: 1, conversationId: 'conv-flow', revision: 3 } }));
  fs.writeFileSync(path.join(dir, 'conv-future.json'), JSON.stringify({ ...V1, id: 'conv-future', version: 99 }));
  const report = migrateConversationDirToV2(dir);
  assert.equal(report.migrated, 0);
  assert.equal(CONVERSATION_VERSION, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('局部 v2 历史：原字节先备份再原子迁移，剪除项不复活，元数据与 SDK 历史原样保留', () => {
  const dir = tmpDir();
  try {
    const record = { ...V1, version: 2, flow: createFlowSnapshot({ conversationId: V1.id }),
      unreadAt: 30, lastReadAt: 20, agentSession: { entries: ['kept'] }, cutKeys: ['cut'],
      turns: [...V1.turns, { id: 'cut', author: 'user', text: '已剪除' }] };
    const target = path.join(dir, `${record.id}.json`), raw = JSON.stringify(record);
    fs.writeFileSync(target, raw);
    const repaired = repairConversationFlowHistory(dir, record);
    assert.equal(repaired.changed, true);
    assert.equal(fs.readFileSync(repaired.backup, 'utf8'), raw);
    const saved = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.deepEqual(saved.turns, record.turns, '原始材料保留，投影排除 cutKeys');
    assert.deepEqual(saved.agentSession, record.agentSession);
    assert.equal(saved.unreadAt, 30); assert.equal(saved.updatedAt, 2);
    assert.deepEqual(saved.flow.timeline.map(item => item.id ?? item.itemId), ['u1', 'h1']);
    assert.equal(repairConversationFlowHistory(dir, saved).changed, false);
    assert.equal(fs.readdirSync(dir).filter(name => name.endsWith('.bak')).length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('历史备份／提交失败均不覆盖源记录；保留备份后可重试', () => {
  const dir = tmpDir();
  try {
    const record = { ...V1, version: 2, flow: createFlowSnapshot({ conversationId: V1.id }) };
    const target = path.join(dir, `${record.id}.json`), raw = JSON.stringify(record);
    fs.writeFileSync(target, raw);
    assert.throws(() => repairConversationFlowHistory(dir, record, { io: { ...fs, writeFileSync() { throw new Error('backup denied'); } } }), /backup denied/);
    assert.equal(fs.readFileSync(target, 'utf8'), raw);
    assert.throws(() => repairConversationFlowHistory(dir, record, { io: { ...fs, renameSync() { throw new Error('commit denied'); } } }), /commit denied/);
    assert.equal(fs.readFileSync(target, 'utf8'), raw);
    assert.equal(fs.readdirSync(dir).some(name => name.includes('historytmp')), false);
    assert.equal(repairConversationFlowHistory(dir, record).changed, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
